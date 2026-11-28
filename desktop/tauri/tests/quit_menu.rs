#[cfg(target_os = "macos")]
#[allow(dead_code, unused_imports)]
#[path = "../src/lib.rs"]
mod host;

fn main() {
    #[cfg(target_os = "macos")]
    host::menu_bar_tests::run();
}
