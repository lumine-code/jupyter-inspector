"""Exercise a real ipykernel behind the small request contract used by stores."""

import json
import os
import signal
import subprocess
import sys
import time
import traceback

from jupyter_client import KernelManager


def reply(client, message_id, timeout):
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("The kernel did not send its shell reply")
        message = client.get_shell_msg(timeout=remaining)
        if message.get("parent_header", {}).get("msg_id") == message_id:
            return message["content"]


def outputs(client, message_id, timeout):
    deadline = time.monotonic() + timeout
    collected = []
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("The kernel did not become idle")
        message = client.get_iopub_msg(timeout=remaining)
        if message.get("parent_header", {}).get("msg_id") != message_id:
            continue
        kind = message["header"]["msg_type"]
        content = message["content"]
        if kind == "status" and content.get("execution_state") == "idle":
            return collected
        if kind in ("stream", "display_data", "execute_result", "error"):
            collected.append({"output_type": kind, **content})


root = os.path.realpath(sys.argv[1])
manager = KernelManager(connection_file=os.path.join(root, "connection.json"))
manager.kernel_spec.argv = [
    sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"
]
client = None


def interrupted(_signal, _frame):
    raise SystemExit(1)


signal.signal(signal.SIGTERM, interrupted)
try:
    manager.start_kernel(cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    client = manager.blocking_client()
    client.start_channels()
    client.wait_for_ready(timeout=25)
    print(json.dumps({"id": 0, "status": "ready", "pythonVersion": sys.version.split()[0]}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        response = {"id": request["id"]}
        try:
            timeout = max(1, (request.get("timeoutMs") or 30000) / 1000)
            if request["type"] == "execute":
                message_id = client.execute(
                    request["code"], silent=True, store_history=False, allow_stdin=False
                )
                content = reply(client, message_id, timeout)
                response.update(status=content["status"], outputs=outputs(client, message_id, timeout))
                if content["status"] == "error":
                    response["error"] = content
            elif request["type"] == "inspect":
                message_id = client.inspect(request["code"], cursor_pos=request["cursorPos"])
                content = reply(client, message_id, timeout)
                response.update(status=content["status"], data=content)
            else:
                raise ValueError("Unsupported live-kernel request: " + request["type"])
        except Exception as error:
            response.update(status="error", error={
                "ename": type(error).__name__, "evalue": str(error),
                "traceback": traceback.format_exception(error),
            })
        print(json.dumps(response), flush=True)
finally:
    if client is not None:
        client.stop_channels()
    if manager.has_kernel:
        manager.shutdown_kernel(now=True)
    manager.cleanup_resources()
