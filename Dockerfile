# 使用官方 Python 镜像作为基础镜像（slim 内无编译器；已确认所有依赖在 3.12 下都有预编译 wheel）
FROM python:3.12-slim

# 让 Python 输出不缓冲，`docker logs` 能实时看到日志
ENV PYTHONUNBUFFERED=1

# 设置工作目录
WORKDIR /app

# 先只装依赖：requirements.txt 不变时这一层走缓存，之后改源码不会重装四十多个包
COPY requirements.txt .
RUN pip install --no-cache-dir --timeout 120 --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

# 再复制应用代码（data/ 与 downloads/ 已被 .dockerignore 排除：运行期由挂载提供，或程序自动创建）
COPY . /app/

# 确保启动脚本可执行
RUN chmod +x start.sh

# 暴露端口
EXPOSE 6696

# 启动应用的命令
CMD ["./start.sh"]
