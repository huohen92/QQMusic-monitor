# 使用官方 Python 镜像作为基础镜像
FROM python:3.12-slim

# 设置工作目录
WORKDIR /app

# 复制应用程序代码到镜像中
COPY . /app/

# 安装依赖 - 使用国内镜像源并增加超时时间
RUN pip install --no-cache-dir --timeout 120 --index-url https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

# 暴露端口
EXPOSE 6696

# 复制启动脚本并赋予执行权限
COPY start.sh .
RUN chmod +x start.sh

# 启动应用的命令
CMD ["./start.sh"]