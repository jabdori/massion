use std::{env, fs, path::PathBuf};

fn main() {
    let source = "../../src/storage.ts";
    println!("cargo:rerun-if-changed={source}");
    let storage = fs::read_to_string(source).expect("read TypeScript storage source");
    let version = storage
        .split_once("export const STORAGE_SCHEMA_VERSION = ")
        .unwrap()
        .1
        .split_once(';')
        .unwrap()
        .0;
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    for name in [
        "SCHEMA",
        "READ_STATE",
        "OPERATION",
        "CATCHUP",
        "EXPORT_JOURNAL",
        "COMMIT",
    ] {
        let sql = storage
            .split_once(&format!("export const {name}_QUERY = `"))
            .unwrap_or_else(|| panic!("missing shared {name} query"))
            .1
            .split_once('`')
            .unwrap()
            .0
            .trim();
        let sql = sql.replace("${STORAGE_SCHEMA_VERSION}", version);
        assert!(!sql.contains("${"), "unexpected interpolation in {name}");
        fs::write(output.join(format!("{name}.surql")), sql).unwrap();
    }
}
