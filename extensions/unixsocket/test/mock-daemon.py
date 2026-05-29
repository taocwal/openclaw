#!/usr/bin/env python3
"""
Mock AI Model Daemon for Unix Socket Provider integration testing.

Speaks the binary frame protocol:
  [4-byte big-endian length header] + [UTF-8 JSON bytes]

Supports:
  - Streaming responses (stream: true)
  - Non-streaming responses (stream: false)
  - Error responses
  - Half-close (shutdown(SHUT_WR)) simulation
  - Parameter validation rejection

Usage:
  python3 test/mock-daemon.py [--socket /tmp/ai-daemon.sock] [--mode streaming|non-streaming|error]
"""

import argparse
import json
import os
import signal
import socket
import struct
import sys
import time


def encode_frame(payload):
    """Encode a payload into the binary frame format."""
    json_bytes = json.dumps(payload).encode("utf-8")
    header = struct.pack(">I", len(json_bytes))
    return header + json_bytes


def read_exact(sock, n):
    """Read exactly n bytes from the socket."""
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def read_frame(sock):
    """Read one complete binary frame from the socket."""
    header = read_exact(sock, 4)
    if header is None:
        return None
    payload_len = struct.unpack(">I", header)[0]
    if payload_len == 0:
        return None
    payload = read_exact(sock, payload_len)
    if payload is None:
        return None
    return json.loads(payload.decode("utf-8"))


def handle_streaming(sock, request):
    """Simulate a streaming response with multiple chunks."""
    model = request.get("model", "unknown")
    messages = request.get("messages", [])
    last_msg = messages[-1]["content"] if messages else ""

    chunks = [
        {"choices": [{"index": 0, "delta": {"content": f"Streaming response to: {last_msg[:30]}..."}, "finish_reason": None}]},
        {"choices": [{"index": 0, "delta": {"content": f" (model: {model})"}, "finish_reason": None}]},
        {"choices": [{"index": 0, "delta": {"content": f"\nTokens: ~45"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 35, "total_tokens": 45}},
    ]

    for chunk in chunks:
        frame = encode_frame(chunk)
        print(f"[mock-daemon] sending chunk: {json.dumps(chunk)[:80]}...")
        sock.sendall(frame)
        time.sleep(0.05)  # Simulate processing delay

    # Simulate half-close
    print("[mock-daemon] half-closing (SHUT_WR)")
    sock.shutdown(socket.SHUT_WR)


def handle_non_streaming(sock, request):
    """Simulate a non-streaming single-frame response."""
    model = request.get("model", "unknown")
    messages = request.get("messages", [])
    last_msg = messages[-1]["content"] if messages else ""

    response = {
        "id": "mock-ns-001",
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": f"Non-streaming response to: {last_msg[:50]}\nModel: {model}\nTokens: ~30",
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    }

    frame = encode_frame(response)
    print(f"[mock-daemon] sending non-streaming response")
    sock.sendall(frame)
    # Full close for non-streaming
    sock.close()


def handle_error(sock, request, error_code="503"):
    """Simulate an error response."""
    model = request.get("model", "unknown")
    error_msg = {
        "error": {
            "message": f"Model '{model}' is not loaded. Please load the model first.",
            "type": "model_not_loaded",
            "code": error_code,
        }
    }
    frame = encode_frame(error_msg)
    print(f"[mock-daemon] sending error frame: {json.dumps(error_msg)}")
    sock.sendall(frame)
    sock.close()


import threading

client_counter = 0
counter_lock = threading.Lock()

def handle_client(sock, mode):
    """Handle a single client connection."""
    global client_counter
    with counter_lock:
        client_counter += 1
        cid = client_counter

    try:
        print(f"[mock-daemon #{cid}] connected, mode={mode}")
        frame = read_frame(sock)
        if frame is None:
            print(f"[mock-daemon #{cid}] no frame received, closing")
            sock.close()
            return

        print(f"[mock-daemon #{cid}] request: {json.dumps(frame)[:120]}...")

        if mode == "streaming":
            handle_streaming(sock, frame)
        elif mode == "non-streaming":
            handle_non_streaming(sock, frame)
        elif mode == "error":
            handle_error(sock, frame)
        elif mode == "multi-client":
            handle_streaming(sock, frame)

        print(f"[mock-daemon #{cid}] done")
    except Exception as e:
        print(f"[mock-daemon #{cid}] error: {e}")
        try:
            sock.close()
        except Exception:
            pass


def main():
    parser = argparse.ArgumentParser(description="Mock AI Model Daemon")
    parser.add_argument("--socket", default="/tmp/ai-daemon.sock", help="Unix socket path")
    parser.add_argument("--mode", default="streaming",
                        choices=["streaming", "non-streaming", "error", "multi-client"],
                        help="Response mode")
    parser.add_argument("--concurrent", action="store_true",
                        help="Handle clients concurrently (thread per connection)")
    args = parser.parse_args()

    # Clean up old socket
    if os.path.exists(args.socket):
        os.unlink(args.socket)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(args.socket)
    server.listen(128)

    print(f"[mock-daemon] listening on {args.socket}, mode={args.mode}, concurrent={args.concurrent}")

    def shutdown(signum, frame):
        print(f"\n[mock-daemon] shutting down...")
        server.close()
        if os.path.exists(args.socket):
            os.unlink(args.socket)
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    while True:
        client, _addr = server.accept()
        if args.concurrent:
            t = threading.Thread(target=handle_client, args=(client, args.mode), daemon=True)
            t.start()
        else:
            handle_client(client, args.mode)


if __name__ == "__main__":
    main()
