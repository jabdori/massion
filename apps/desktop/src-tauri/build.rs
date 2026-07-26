fn main() {
    // 해시가 붙은 renderer 자산 목록은 index.html에 기록되므로, 파일 내용 변경도 Cargo 입력으로 추적합니다.
    println!("cargo:rerun-if-changed=../dist/index.html");
    // renderer 출력 디렉터리 자체의 교체도 추적합니다.
    println!("cargo:rerun-if-changed=../dist");
    // 원자적으로 교체되는 runtime stage의 새 파일도 다음 Cargo 빌드에서 다시 복사합니다.
    println!("cargo:rerun-if-changed=.runtime-stage.stamp");
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "bootstrap",
            "query",
            "command",
            "stream_start",
            "stream_stop",
        ]),
    ))
    .expect("Tauri 앱 권한 매니페스트 생성 실패")
}
