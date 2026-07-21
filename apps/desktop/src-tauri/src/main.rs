// Windows release에서 콘솔 창을 띄우지 않습니다.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    massion_desktop_lib::run()
}
