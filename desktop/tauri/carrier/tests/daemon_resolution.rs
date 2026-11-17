use massion_carrier::daemon::{child_environment, node_binary, node_binary_dev, node_binary_release, CHILD_ENV_ALWAYS, CHILD_ENV_DEBUG_ONLY};

#[test]
fn node_resolution_and_child_environment_follow_the_build_mode() {
    assert_eq!(node_binary_dev(Some("/opt/special-node".into())), "/opt/special-node");
    assert_eq!(node_binary_dev(None), "node");

    let root = std::env::temp_dir().join(format!("massion-node-resolution-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    assert_eq!(node_binary_release(&root).unwrap_err(), "The bundled Node executable is missing");
    std::fs::write(root.join("node"), b"#!/bin/sh\n").unwrap();
    assert_eq!(node_binary_release(&root).unwrap(), root.join("node").to_string_lossy().to_string());

    // This is a debug build: the development override is honoured and a bare
    // node on PATH is the default; a release build resolves only inside the
    // app bundle (node_binary_release above).
    std::env::set_var("MASSION_NODE_BINARY", "/opt/special-node");
    assert_eq!(node_binary().unwrap(), "/opt/special-node");
    std::env::remove_var("MASSION_NODE_BINARY");
    assert_eq!(node_binary().unwrap(), "node");

    std::env::set_var("NODE_OPTIONS", "--require=evil");
    std::env::set_var("MASSION_SURREAL_RPC", "ws://127.0.0.1:1");
    std::env::set_var("MASSION_LEAK", "nope");
    let environment = child_environment();
    for (name, value) in &environment {
        let allowed = CHILD_ENV_ALWAYS.contains(&name.as_str()) || CHILD_ENV_DEBUG_ONLY.contains(&name.as_str());
        assert!(allowed, "unexpected name in the child environment: {}", name);
        assert!(!name.is_empty() && !value.is_empty() || name == "TMPDIR");
    }
    let names: Vec<&str> = environment.iter().map(|(name, _)| name.as_str()).collect();
    assert!(names.contains(&"HOME"));
    assert!(names.contains(&"MASSION_SURREAL_RPC"), "debug builds pass the database override");
    assert!(!names.contains(&"NODE_OPTIONS"), "NODE_OPTIONS must never reach the child");
    assert!(!names.contains(&"MASSION_LEAK"), "arbitrary names must never reach the child");
    std::env::remove_var("NODE_OPTIONS");
    std::env::remove_var("MASSION_SURREAL_RPC");
    std::env::remove_var("MASSION_LEAK");
    let _ = std::fs::remove_dir_all(&root);
}
