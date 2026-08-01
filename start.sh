#!/bin/bash

# 启动 Uvicorn web 服务器 (前台运行)
echo "Starting Uvicorn server..."
uvicorn main:app --host 0.0.0.0 --port 6696

# 如果uvicorn退出，脚本也会退出