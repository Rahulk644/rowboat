fn main() {
    if let Err(error) = meeting_bridge::protocol::serve_control_stdio() {
        eprintln!("meeting-bridge control protocol failed: {error}");
        std::process::exit(1);
    }
}
