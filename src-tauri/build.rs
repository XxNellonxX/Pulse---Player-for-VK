fn main() {
    println!("cargo:rerun-if-env-changed=PULSE_GATEWAY_URL");
    tauri_build::build()
}
