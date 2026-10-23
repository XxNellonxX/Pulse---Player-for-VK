fn main() {
    println!("cargo:rerun-if-env-changed=PULSE_GATEWAY_URL");
    println!("cargo:rerun-if-env-changed=PULSE_SPOTIFY_CLIENT_ID");
    tauri_build::build()
}
