#!/bin/bash

# 启动 Uvicorn web 服务器 (前台运行)
# -u  ：不缓冲 stdout，让 `docker logs` 能实时看到输出（网页日志页本来就实时，不受影响）
# exec：让 uvicorn 直接接管 PID 1，这样 `docker stop` 的 SIGTERM 能传到应用，
#       触发优雅退出（取消下载 worker 并保存任务状态），而不是等 10 秒后被 SIGKILL
echo "Starting Uvicorn server..."
exec uvicorn main:app --host 0.0.0.0 --port 6696 -u

# 如果uvicorn退出，脚本也会退出
