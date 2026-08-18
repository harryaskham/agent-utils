#!/usr/bin/env python3
"""Small stdio-to-PTY bridge for Agent Utils interactive-shell on Darwin.

BSD script(1) requires its own stdin to be a controlling terminal and fails with
"tcgetattr/ioctl: Operation not supported on socket" when Node connects it with
pipes. This bridge allocates the child PTY directly while keeping byte-stream
stdin/stdout for the Pi overlay.
"""

import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios


def set_window_size(fd: int) -> None:
    rows = max(1, int(os.environ.get("LINES", "24")))
    cols = max(1, int(os.environ.get("COLUMNS", "80")))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: pty-bridge.py COMMAND [ARG ...]", file=sys.stderr)
        return 2

    pid, master = pty.fork()
    if pid == 0:
        os.execvpe(sys.argv[1], sys.argv[1:], os.environ)

    set_window_size(master)

    def forward_signal(signum, _frame):
        try:
            os.killpg(pid, signum)
        except ProcessLookupError:
            pass

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, forward_signal)

    stdin_fd = sys.stdin.fileno()
    watched = [master, stdin_fd]
    while master in watched:
        try:
            readable, _, _ = select.select(watched, [], [])
        except InterruptedError:
            continue
        if master in readable:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b""
            if not data:
                watched.remove(master)
            else:
                os.write(sys.stdout.fileno(), data)
        if stdin_fd in readable:
            data = os.read(stdin_fd, 65536)
            if not data:
                watched.remove(stdin_fd)
            else:
                try:
                    os.write(master, data)
                except OSError:
                    if master in watched:
                        watched.remove(master)

    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status)


if __name__ == "__main__":
    raise SystemExit(main())
