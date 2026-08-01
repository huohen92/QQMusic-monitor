import re
from fastapi import FastAPI, Request, Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List
import uvicorn
import base64
import asyncio
import os
import qq_music
import monitor
import tasks
from tasks import add_song_to_queue, load_download_tasks, start_download_workers
from contextlib import asynccontextmanager

# --- 从 tasks 模块导入 download_tasks ---
download_tasks = tasks.download_tasks

# --- 全局变量，用于管理后台任务 ---
worker_tasks = []

@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理器"""
    # --- 启动时执行 ---
    print("Application startup...")
    await tasks.load_download_tasks()
    # 启动下载工作者（消费者）
    global worker_tasks
    worker_tasks = start_download_workers()
    # 初始化 qqmusic api 会话
    qq_music.initialize_qqmusic_session()
    await qq_music.initialize_from_cookie()
    # 启动后台监控任务
    monitor.start_monitoring_task()
    # 启动定时重试任务
    tasks.start_retry_task()
    # 初始化并启动歌曲索引管理器
    from utils import song_index_manager
    await song_index_manager.update_index()
    song_index_manager.start_background_update()
    print(f"应用启动时歌曲索引状态: {len(song_index_manager.get_existing_song_basenames())} 首本地歌曲")
    
    yield
    
    # --- 关闭时执行 ---
    print("Application shutdown...")
    # 取消所有后台下载任务
    for task in worker_tasks:
        task.cancel()
    await asyncio.gather(*worker_tasks, return_exceptions=True)
    print("所有下载工作者已停止。")
    
    # 在关闭前最后保存一次任务状态
    print("正在保存最终任务状态...")
    await tasks._save_download_tasks()
    
    await qq_music.close_qqmusic_session()

app = FastAPI(title="QQ音乐下载器", lifespan=lifespan)

# 定义数据和下载目录
DATA_DIR = "data"
DOWNLOADS_DIR = "downloads"

# 确保目录在启动时存在
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(DOWNLOADS_DIR, exist_ok=True)

# 挂载静态文件目录
app.mount("/static", StaticFiles(directory="static"), name="static")
# 挂载下载文件目录，使其可以通过 /downloads 访问
app.mount("/downloads", StaticFiles(directory=DOWNLOADS_DIR), name="downloads")
templates = Jinja2Templates(directory="templates")

async def check_auth_status():
    """依赖函数：等待认证完成并检查登录状态"""
    await qq_music.auth_completed.wait()
    if not qq_music.is_login_valid():
        raise HTTPException(status_code=401, detail="用户未登录或凭证无效")

@app.get("/api/check-auth")
async def check_auth():
    """检查初始认证状态（用于页面加载）"""
    await qq_music.auth_completed.wait()
    return {"is_logged_in": qq_music.is_login_valid()}

@app.get("/api/user/info")
async def user_info():
    """获取当前登录用户的昵称和头像"""
    await qq_music.auth_completed.wait()
    if not qq_music.is_login_valid():
        return {"nick_name": "", "head_url": ""}
    info = await qq_music.get_user_info()
    if not info:
        return {"nick_name": "", "head_url": ""}
    return info

@app.get("/api/login/qrcode")
async def login_qrcode(login_type: str = "QQ"):
    """获取登录二维码"""
    qrcode_data = await qq_music.get_login_qrcode(login_type)
    qrcode_b64 = base64.b64encode(qrcode_data).decode("utf-8")
    return {"qrcode": f"data:image/png;base64,{qrcode_b64}"}

@app.get("/api/login/status")
async def login_status():
    """检查登录状态"""
    return await qq_music.check_login_status()

# --- 手机号登录相关 API --- 

@app.post("/api/login/send-code")
async def send_code(phone: str):
    """发送验证码到手机"""
    return await qq_music.send_sms_code(phone)

@app.post("/api/login/phone")
async def phone_login(phone: str, auth_code: str):
    """使用手机号和验证码登录"""
    return await qq_music.phone_login(phone, auth_code)

@app.post("/api/logout")
async def logout():
    """退出登录，删除 cookie 文件"""
    from utils import save_credentials
    from utils import CREDENTIALS_FILE_PATH
    
    # 删除凭证文件
    if os.path.exists(CREDENTIALS_FILE_PATH):
        os.remove(CREDENTIALS_FILE_PATH)
    
    # 清除内存中的凭证状态
    save_credentials(None)
    
    # 更新会话以清除凭证
    qq_music.initialize_qqmusic_session()
    return {"status": "success"}

# Helper function to get a set of existing filenames without extension
def get_existing_song_basenames():
    from utils import song_index_manager
    return song_index_manager.get_existing_song_basenames()


@app.get("/api/playlists", dependencies=[Depends(check_auth_status)])
async def api_get_user_playlists():
    """获取当前登录用户的歌单"""
    try:
        cred = qq_music.get_credential()
        playlists = await qq_music.get_user_playlists(cred.musicid)
        return playlists
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/search", dependencies=[Depends(check_auth_status)])
async def api_search_song(keyword: str, page: int = 1, num: int = 20):
    """搜索歌曲"""
    try:
        if not keyword.strip():
            return {"error": "搜索关键词不能为空"}
        return await qq_music.search_song(keyword.strip(), page, num)
    except Exception as e:
        return {"error": str(e)}

@app.get("/api/playlist/{playlist_id}", dependencies=[Depends(check_auth_status)])
async def api_get_playlist_songs(playlist_id: int):
    """获取歌单中的歌曲，并检查本地下载状态"""
    try:
        songs = await qq_music.get_playlist_songs(playlist_id)
        if not isinstance(songs, list):
            return songs  # Return original response if not a list

        from utils import song_index_manager
        existing_files = get_existing_song_basenames()

        for song in songs:
            # 优先从内存任务列表获取状态
            task_info = download_tasks.get(song.get("mid"))
            if task_info:
                song["status"] = task_info.get("status")
                # 如果是已完成状态，也一并提供下载链接
                if task_info.get("status") == "completed":
                    song["url"] = task_info.get("url")
                continue  # 如果在内存中找到，则跳过文件检查

            # 如果内存中没有，使用智能检测方法检查文件系统
            song_name = song.get('name', '')
            singer_names = [s.get('name', '') for s in song.get('singer', [])]
            
            # 查找匹配的本地歌曲
            matching_songs = song_index_manager.find_matching_songs(song_name, singer_names)
            if matching_songs:
                # 选择第一个匹配的歌曲
                local_song = matching_songs[0]
                song["status"] = "completed"
                song["local_info"] = {
                    "filename": local_song["filename"],
                    "quality": local_song["quality"],
                    "size": local_song["size"],
                    "extension": local_song["extension"]
                }
                # 注意：这里无法轻易获取到确切的文件扩展名，所以无法生成下载链接
                # 但至少前端可以显示“已下载”
        return songs
    except Exception as e:
        return {"error": str(e)}

@app.post("/api/playlist/download/{playlist_id}", dependencies=[Depends(check_auth_status)])
async def download_playlist(playlist_id: int):
    """将整个歌单的歌曲加入下载队列，非阻塞"""
    try:
        songs = await qq_music.get_playlist_songs(playlist_id)
        if not isinstance(songs, list):
            raise HTTPException(status_code=404, detail="无法获取歌单歌曲")

        added_count = 0
        for song in songs:
            song_mid = song.get("mid")
            if not song_mid:
                continue

            if song_mid not in download_tasks or download_tasks[song_mid].get('status') != 'completed':
                song_name = f"{song.get('name', '未知歌曲')} - {', '.join(s.get('name', '未知歌手') for s in song.get('singer', []))}"
                # 将任务放入队列，这是一个快速的非阻塞操作
                await add_song_to_queue(song_mid, song_name)
                added_count += 1
        
        return {"status": "success", "message": f"已将 {added_count} 首歌曲加入下载队列。"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/download/{song_mid}", dependencies=[Depends(check_auth_status)])
async def download_song(song_mid: str, song_name: str):
    """将一首歌曲加入下载队列"""
    if song_mid in download_tasks and download_tasks[song_mid]['status'] in ['downloading', 'completed', 'queued']:
        return {"status": "skipped", "message": "任务已在队列中或已完成"}

    await add_song_to_queue(song_mid, song_name)
    return {"status": "starting", "message": "已加入下载队列"}

@app.get("/api/play/{song_mid}", dependencies=[Depends(check_auth_status)])
async def play_song(song_mid: str):
    """获取歌曲的网页播放地址"""
    try:
        info = await qq_music.get_playback_url(song_mid)
        if not info:
            raise HTTPException(status_code=404, detail="无法获取播放链接")
        return info
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/download/status")
async def get_download_status():
    """获取所有下载任务的状态，并检查已完成文件是否存在"""
    import time

    cred = qq_music.get_credential()
    cooldown_until = qq_music.get_cooldown_until(cred)

    tasks_to_update = []
    for mid, task in download_tasks.items():
        if task.get("status") == "completed":
            file_path = task.get("file_path")
            # 检查文件路径是否存在且在文件系统中是否真的存在
            if file_path and not os.path.exists(file_path):
                tasks_to_update.append(mid)

    # 如果有任何已完成但文件被删除的任务，更新它们的状态
    if tasks_to_update:
        for mid in tasks_to_update:
            if mid in download_tasks:
                download_tasks[mid]["status"] = "failed"  # 标记为失败
                download_tasks[mid]["error"] = "本地文件已被删除"
                download_tasks[mid]["progress"] = 0
        
        # 将更新后的状态保存回文件
        await tasks._save_download_tasks()

    return {
        "tasks": download_tasks,
        "api_cooldown_until": cooldown_until,
        "server_time": int(time.time())
    }

class TaskActionPayload(BaseModel):
    mids: List[str]
    delete_files: bool = False

@app.post("/api/downloads/remove_selected")
async def remove_selected_downloads(payload: TaskActionPayload):
    """移除选定的下载任务"""
    removed_count = 0
    deleted_files_count = 0
    
    for mid in payload.mids:
        task = download_tasks.get(mid)
        if not task:
            continue

        if payload.delete_files:
            try:
                file_path = task.get("file_path")
                if file_path and os.path.exists(file_path):
                    os.remove(file_path)
                    deleted_files_count += 1
            except OSError as e:
                print(f"删除文件失败: {e}")

        del download_tasks[mid]
        removed_count += 1

    await tasks._save_download_tasks()

    message = f"已移除 {removed_count} 个任务。"
    if payload.delete_files:
        message += f" 并删除了 {deleted_files_count} 个文件。"
        
    return {"status": "success", "message": message}

@app.post("/api/downloads/retry_all_failed")
async def retry_all_failed_downloads():
    """重试所有失败的下载任务"""
    failed_tasks = {
        mid: task
        for mid, task in download_tasks.items()
        if task.get("status") == "failed"
    }
    
    if not failed_tasks:
        return {"status": "no_action", "message": "没有失败的任务需要重试。"}

    retried_count = 0
    for mid, task in failed_tasks.items():
        song_name = task.get("song_name", "未知歌曲")
        await add_song_to_queue(mid, song_name)
        retried_count += 1
    
    return {"status": "success", "message": f"已将 {retried_count} 个失败的任务重新加入队列。"}


@app.post("/api/download/retry/{song_mid}")
async def retry_download(song_mid: str):
    """重试一个失败的下载任务"""
    task = download_tasks.get(song_mid)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task.get("status") != "failed":
        raise HTTPException(status_code=400, detail="只能重试失败的任务")
    
    song_name = task.get("song_name", "未知歌曲")
    await add_song_to_queue(song_mid, song_name)
    return {"status": "success", "message": "任务已重新加入下载队列。"}

@app.post("/api/download/cancel/{song_mid}")
async def cancel_download(song_mid: str):
    """取消一个正在进行或排队中的任务"""
    task = download_tasks.get(song_mid)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    if task.get("status") in ("queued", "downloading"):
        # 下载中/排队中：标记为取消，下载循环会在下一个 chunk 检测到并中断
        download_tasks[song_mid].update(
            {"status": "cancelled", "error": "用户手动取消"}
        )
        await tasks._save_download_tasks()
        return {"status": "success", "message": "任务已取消"}
    else:
        return {"status": "failed", "message": "当前状态无法取消"}


@app.post("/api/download/remove/{song_mid}")
async def remove_download_task(song_mid: str):
    """从列表中移除一个任务（通常用于失败或已取消的任务）"""
    if song_mid not in download_tasks:
        raise HTTPException(status_code=404, detail="任务不存在")

    del download_tasks[song_mid]
    await tasks._save_download_tasks()
    return {"status": "success", "message": "任务已从列表移除"}

# --- 配置管理 API --- 

@app.get("/api/config")
async def get_config():
    """获取当前配置"""
    from config import config
    return {"config": config.get_full_config()}

@app.put("/api/config")
async def update_config(new_config: dict):
    """更新配置"""
    from config import config
    if config.update_config(new_config):
        return {"status": "success", "message": "配置已更新"}
    else:
        raise HTTPException(status_code=500, detail="更新配置失败")

@app.put("/api/config/{key_path}")
async def update_config_key(key_path: str, value: dict):
    """更新单个配置项"""
    from config import config
    if config.set(key_path, value["value"]):
        return {"status": "success", "message": f"配置项 {key_path} 已更新"}
    else:
        raise HTTPException(status_code=500, detail="更新配置项失败")

@app.post("/api/config/reset")
async def reset_config():
    """重置配置为默认值"""
    from config import config
    if config.reset_config():
        return {"status": "success", "message": "配置已重置", "config": config.get_full_config()}
    else:
        raise HTTPException(status_code=500, detail="重置配置失败")

# --- 歌单监控 API ---

# 测试端点：直接返回所有本地歌曲信息
@app.get("/api/test-local-songs")
async def test_local_songs():
    """返回所有本地歌曲信息"""
    from utils import song_index_manager
    
    return {
        "local_songs": list(song_index_manager._index["by_basename"].values()),
        "count": len(song_index_manager._index["by_basename"])
    }

# 测试端点：直接测试本地歌曲匹配
@app.get("/api/test-local-matching")
async def test_local_matching():
    """测试本地歌曲匹配功能"""
    from utils import song_index_manager
    
    # 测试匹配我们的本地歌曲
    test_cases = [
        ("SPOTLIGHT HUNTER", ["三角洲行动", "SIENA"]),
        ("Dawn", ["三角洲行动", "Lithium Done"]),
        ("Lemon", ["米津玄師"])
    ]
    
    results = []
    for song_name, singer_names in test_cases:
        matching_songs = song_index_manager.find_matching_songs(song_name, singer_names)
        results.append({
            "test_song": f"{song_name} - {', '.join(singer_names)}",
            "matching_songs": matching_songs,
            "match_count": len(matching_songs)
        })
    
    return {
        "local_songs": list(song_index_manager._index["by_basename"].values()),
        "test_results": results
    }

@app.post("/api/monitor/{playlist_id}", dependencies=[Depends(check_auth_status)])
async def toggle_playlist_monitoring(playlist_id: str):
    """切换一个歌单的监控状态"""
    try:
        await monitor.toggle_monitoring(playlist_id)
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/monitor/status", dependencies=[Depends(check_auth_status)])
async def get_monitoring_status():
    """获取正在监控的歌单ID列表"""
    try:
        ids = await monitor.get_monitored_playlist_ids()
        return ids
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/monitored-playlists-config", dependencies=[Depends(check_auth_status)])
async def get_monitored_playlists_config():
    """获取所有已监控歌单的下载目录配置"""
    try:
        return await monitor.get_monitored_playlists_config()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.put("/api/monitored-playlists-config", dependencies=[Depends(check_auth_status)])
async def update_monitored_playlists_config(config_data: dict):
    """批量更新已监控歌单的下载目录配置

    Body 格式: {"<playlist_id>": {"download_dir": "downloads/新歌"}, ...}
    """
    try:
        updated = await monitor.update_monitored_playlists_config(config_data)
        return {"status": "success", "config": updated}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    """
    主页，显示歌单和下载状态。
    """
    import time
    current_timestamp = int(time.time())
    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={"current_timestamp": current_timestamp},
    )

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=6696)
