use anyhow::{Context, Result, ensure};
use chrono::{SecondsFormat, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
use surrealdb::{
    IndexedResults, Surreal,
    engine::local::{Db, SurrealKv},
    opt::{Config, capabilities::Capabilities},
    types::{Uuid, Value as DbValue},
};
use tokio::sync::Mutex;

macro_rules! sql {
    ($name:literal) => {
        include_str!(concat!(env!("OUT_DIR"), "/", $name, ".surql"))
    };
}

pub const MAX_SAFE: u64 = (1 << 53) - 1;

pub fn safe_integer(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number >= 0.0 && number <= MAX_SAFE as f64 && number.fract() == 0.0).then_some(number as u64)
}

// Object.keys().sort() compares UTF-16 units, and JSON.stringify uses JS number syntax.
pub fn canonical(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let entries = keys
                .into_iter()
                .map(|key| format!("{}:{}", json!(key), canonical(&object[key])))
                .collect::<Vec<_>>();
            format!("{{{}}}", entries.join(","))
        }
        Value::Number(number) => ryu_js::Buffer::new()
            .format_finite(number.as_f64().unwrap())
            .to_owned(),
        _ => value.to_string(),
    }
}

fn hash(data: &str) -> String {
    format!("{:x}", Sha256::digest(data))
}

pub struct Store {
    db: Surreal<Db>,
    writes: Mutex<()>,
    pause_before_commit: bool,
}

fn bindings(sql: &str, variables: Value) -> (String, Value) {
    // Match the TypeScript RPC's encoding::json::decode, including record-shaped strings.
    let mut query = String::new();
    let mut bound = serde_json::Map::new();
    for (index, (key, value)) in variables.as_object().unwrap().iter().enumerate() {
        let wire = format!("__massion_json_{index}");
        query.push_str(&format!("LET ${key} = encoding::json::decode(${wire});\n"));
        bound.insert(wire, json!(canonical(value)));
    }
    query.push_str(sql);
    (query, Value::Object(bound))
}

fn result(response: IndexedResults) -> Result<Value> {
    let mut response = response.check()?;
    let mut result = None;
    for index in 0..response.num_statements() {
        let value = response.take::<DbValue>(index)?.into_json_value();
        if !value.is_null() {
            ensure!(result.replace(value).is_none(), "Multiple query results");
        }
    }
    Ok(result.unwrap_or(Value::Null))
}

impl Store {
    pub async fn open(directory: &Path, pause_before_commit: bool) -> Result<Self> {
        let path = directory.to_str().context("database path must be UTF-8")?;
        let capabilities = Capabilities::default()
            .with_all_net_targets_denied()
            .with_scripting(false);
        let db =
            Surreal::new::<SurrealKv>((path, Config::new().capabilities(capabilities))).await?;
        db.use_ns("massion").use_db("massion").await?;
        Ok(Self {
            db,
            writes: Mutex::new(()),
            pause_before_commit,
        })
    }

    async fn query(&self, sql: &str, variables: Value) -> Result<Value> {
        let (sql, bound) = bindings(sql, variables);
        result(self.db.query(sql).bind(bound).await?)
    }

    pub async fn initialize(&self) -> Result<()> {
        let created = self
            .query(
                sql!("SCHEMA"),
                json!({"feedId": Uuid::new_v4().to_string()}),
            )
            .await?;
        ensure!(created == true, "Schema initialization was not confirmed");
        Ok(())
    }

    pub async fn shutdown(&self) -> Result<()> {
        Ok(self.db.shutdown().await?)
    }

    pub async fn read_state(&self, mission: Option<&str>) -> Result<Value> {
        let key = mission.map(hash).unwrap_or_default();
        let row = self
            .query(sql!("READ_STATE"), json!({"aggregateKey": key}))
            .await?;
        ensure!(
            row["feedId"].is_string() && safe_integer(&row["cursor"]).is_some(),
            "Invalid read boundary"
        );
        let state = &row["state"];
        let snapshot = if state.is_null() {
            Value::Null
        } else {
            ensure!(
                state["aggregateId"].as_str() == mission
                    && safe_integer(&state["revision"]).is_some_and(|r| r > 0)
                    && state.get("value").is_some(),
                "Invalid snapshot"
            );
            json!({"revision": state["revision"], "value": state["value"]})
        };
        Ok(json!({"feedId": row["feedId"], "cursor": row["cursor"], "snapshot": snapshot}))
    }

    pub async fn catchup(
        &self,
        after: u64,
        feed: Option<&str>,
        limit: u64,
    ) -> Result<Option<Value>> {
        let row = self
            .query(
                sql!("CATCHUP"),
                json!({"after": after, "feedId": feed.unwrap_or_default(), "limit": limit}),
            )
            .await?;
        let head = safe_integer(&row["head"]).context("Invalid event head")?;
        let feed_id = row["feedId"].as_str().context("Invalid feed identity")?;
        if after > head || feed.is_some_and(|expected| expected != feed_id) {
            return Ok(None);
        }
        let events = row["events"].as_array().context("Invalid event page")?;
        let mut cursor = after;
        for batch in events {
            let next = safe_integer(&batch["cursor"]).context("Invalid event cursor")?;
            ensure!(
                next > cursor
                    && next <= head
                    && safe_integer(&batch["revision"]).is_some_and(|r| r > 0)
                    && batch["commandId"].is_string()
                    && batch["aggregateId"].is_string()
                    && batch["events"].is_array(),
                "Invalid event batch"
            );
            cursor = next;
        }
        Ok(Some(
            json!({"feedId": feed_id, "cursor": cursor, "events": events}),
        ))
    }

    pub async fn export_journal(&self) -> Result<Value> {
        self.query(sql!("EXPORT_JOURNAL"), json!({})).await
    }

    pub async fn inspect_rows(&self) -> Result<Value> {
        self.query(include_str!("../inspect.surql"), json!({}))
            .await
    }

    pub async fn create(&self, input: Value, command_id: &str, feed: &str) -> Result<Value> {
        let id = input["id"].as_str().unwrap().to_owned();
        let actor = "local-owner";
        let fingerprint = hash(&canonical(
            &json!({"actorId": actor, "input": input, "kind": "create"}),
        ));
        let operation_key = hash(command_id);
        let _write = self.writes.lock().await;
        let existing = self
            .query(sql!("OPERATION"), json!({"operationKey": operation_key}))
            .await?;
        if !existing.is_null() {
            let revision = safe_integer(&existing["revision"])
                .filter(|n| *n > 0)
                .context("Invalid stored operation revision")?;
            if existing["aggregateId"] != id
                || existing["commandId"] != command_id
                || existing["fingerprint"] != fingerprint
            {
                return Ok(
                    json!({"status": "conflict", "revision": revision, "reason": "idempotency"}),
                );
            }
            ensure!(existing.get("value").is_some(), "Invalid stored receipt");
            return Ok(
                json!({"status": "replayed", "revision": revision, "value": existing["value"]}),
            );
        }
        let mut value = input;
        value["version"] = json!(1);
        for key in ["works", "memories", "growth", "relations"] {
            value[key] = json!([]);
        }
        let event = json!({"type": "mission-created", "actor": actor});
        let content = json!({"id": id, "commandId": command_id, "fingerprint": fingerprint,
            "expectedRevision": 0, "value": value, "events": [event], "outbox": []});
        let variables = json!({"expectedFeed": feed, "aggregateId": id, "aggregateKey": hash(&id),
            "operationKey": operation_key, "commandId": command_id, "fingerprint": fingerprint,
            "contentDigest": hash(&canonical(&content)), "expectedRevision": 0, "value": value,
            "events": [event], "outbox": [], "eventRows": [{"key": format!("{operation_key}_0"), "ordinal": 0, "payload": event}],
            "outboxRows": [], "recordedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            "deadlinePassed": false, "requiresKey": "", "requiredRevision": 0});
        let sql = sql!("COMMIT");
        let body = sql
            .strip_prefix("BEGIN TRANSACTION;")
            .and_then(|s| s.strip_suffix("COMMIT TRANSACTION;"))
            .context("Unexpected commit transaction layout")?;
        let (sql, bound) = bindings(body, variables);
        let transaction = self.db.clone().begin().await?;
        let response = match transaction
            .query(sql)
            .bind(bound)
            .await
            .map_err(anyhow::Error::from)
            .and_then(result)
        {
            Ok(response) => response,
            Err(error) => {
                transaction.cancel().await?;
                return Err(error);
            }
        };
        if self.pause_before_commit && response["status"] == "committed" {
            println!("write-staged-before-commit");
            std::future::pending::<()>().await;
        }
        transaction.commit().await?;
        Ok(response)
    }
}
