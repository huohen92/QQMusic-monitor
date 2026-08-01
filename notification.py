import asyncio
import httpx
import json
import time
from typing import Dict, Any, Optional
from config import config

class NotificationManager:
    """通知管理模块，支持多种通知方式"""
    def __init__(self):
        self._config = config
        self._clients = {}
    
    async def _get_client(self, client_id: str = "default") -> httpx.AsyncClient:
        """获取或创建HTTP客户端"""
        if client_id not in self._clients:
            self._clients[client_id] = httpx.AsyncClient(timeout=10.0)
        return self._clients[client_id]
    
    async def _send_webhook(self, message: str, title: str = "QQ音乐下载器通知") -> bool:
        """发送Webhook通知"""
        webhook_config = self._config.get("notification.webhook")
        if not webhook_config or not webhook_config.get("enabled", False):
            return False
        
        url = webhook_config.get("url")
        if not url:
            return False
        
        try:
            client = await self._get_client("webhook")
            payload = {
                "title": title,
                "message": message,
                "timestamp": int(time.time())
            }
            
            response = await client.post(url, json=payload)
            response.raise_for_status()
            return True
        except Exception as e:
            print(f"发送Webhook通知失败: {e}")
            return False
    
    async def _send_bark(self, message: str, title: str = "QQ音乐下载器通知") -> bool:
        """发送Bark通知"""
        bark_config = self._config.get("notification.bark")
        if not bark_config or not bark_config.get("enabled", False):
            return False

        server_url = bark_config.get("server_url", "https://api.day.app")
        device_key = bark_config.get("device_key")
        if not device_key:
            return False

        try:
            client = await self._get_client("bark")
            # Bark API格式：https://api.day.app/[device_key]/[title]/[body]
            # 需要对特殊字符进行URL编码
            import urllib.parse
            encoded_title = urllib.parse.quote(title)
            encoded_message = urllib.parse.quote(message)
            url = f"{server_url}/{device_key}/{encoded_title}/{encoded_message}"

            response = await client.get(url)
            response.raise_for_status()
            return True
        except Exception as e:
            print(f"发送Bark通知失败: {e}")
            return False

    async def _send_wecom(self, message: str, title: str = "QQ音乐下载器通知") -> bool:
        """发送企业微信群机器人通知 (Webhook + 纯文本)

        Args:
            message: 通知内容
            title: 通知标题

        Returns:
            bool: 是否发送成功
        """
        wecom_config = self._config.get("notification.wecom")
        if not wecom_config or not wecom_config.get("enabled", False):
            return False

        webhook_url = wecom_config.get("webhook_url")
        if not webhook_url:
            return False

        try:
            client = await self._get_client("wecom")
            # 企业微信机器人 Webhook 纯文本消息
            # 纯文本无独立标题字段，标题并入 content（上限 2048 字节）
            content = f"{title}\n{message}"
            payload = {
                "msgtype": "text",
                "text": {"content": content},
            }
            response = await client.post(webhook_url, json=payload)
            response.raise_for_status()
            return True
        except Exception as e:
            print(f"发送企业微信通知失败: {e}")
            return False

    async def send_notification(self, message: str, title: str = "QQ音乐下载器通知") -> Dict[str, bool]:
        """发送通知，支持多种渠道并行发送

        Args:
            message: 通知内容
            title: 通知标题

        Returns:
            Dict[str, bool]: 各渠道发送结果
        """
        results = {}

        # 并行发送所有启用的通知
        tasks = []

        # Webhook通知
        webhook_task = asyncio.create_task(self._send_webhook(message, title))
        tasks.append(("webhook", webhook_task))

        # Bark通知
        bark_task = asyncio.create_task(self._send_bark(message, title))
        tasks.append(("bark", bark_task))

        # 企业微信通知
        wecom_task = asyncio.create_task(self._send_wecom(message, title))
        tasks.append(("wecom", wecom_task))

        # 等待所有通知发送完成
        for name, task in tasks:
            try:
                results[name] = await task
            except Exception as e:
                print(f"{name}通知任务执行失败: {e}")
                results[name] = False

        return results
    
    async def send_download_complete_notification(self, song_name: str, quality: str, file_size: str = "", file_path: str = "") -> Dict[str, bool]:
        """发送下载完成通知

        Args:
            song_name: 歌曲名称
            quality: 下载音质
            file_size: 文件大小（可选）
            file_path: 歌曲保存目录（可选，不含文件名）

        Returns:
            Dict[str, bool]: 各渠道发送结果
        """
        size_line = f"\n文件大小: {file_size}" if file_size else ""
        path_line = f"\n下载位置: {file_path}" if file_path else ""
        message = f"歌曲名称: {song_name}\n下载音质: {quality}{size_line}{path_line}\n下载时间: {time.strftime('%Y-%m-%d %H:%M:%S')}"
        return await self.send_notification(message, "歌曲下载完成")

    async def send_download_failed_notification(self, song_name: str, error: str) -> Dict[str, bool]:
        """发送下载失败通知

        Args:
            song_name: 歌曲名称
            error: 失败原因

        Returns:
            Dict[str, bool]: 各渠道发送结果
        """
        message = f"歌曲名称: {song_name}\n失败原因: {error}\n失败时间: {time.strftime('%Y-%m-%d %H:%M:%S')}"
        return await self.send_notification(message, "歌曲下载失败")

    async def send_playlist_update_notification(self, playlist_name: str, new_songs: list) -> Dict[str, bool]:
        """发送歌单更新通知

        Args:
            playlist_name: 歌单名称
            new_songs: 新歌曲列表

        Returns:
            Dict[str, bool]: 各渠道发送结果
        """
        song_list = "\n".join([f"- {song['name']} - {', '.join(s['name'] for s in song['singer'])}" for song in new_songs[:5]])
        if len(new_songs) > 5:
            song_list += f"\n... 等共 {len(new_songs)} 首新歌曲"

        message = f"歌单名称: {playlist_name}\n新增歌曲: {len(new_songs)}首\n\n{song_list}\n\n更新时间: {time.strftime('%Y-%m-%d %H:%M:%S')}"
        return await self.send_notification(message, "歌单更新提醒")

    async def send_playlist_completion_notification(self, playlist_name: str, completed_songs: list) -> Dict[str, bool]:
        """发送监控歌单新增歌曲部分下载完成通知

        Args:
            playlist_name: 歌单名称
            completed_songs: 已下载完成的歌曲列表（含 name 和 singer）

        Returns:
            Dict[str, bool]: 各渠道发送结果
        """
        song_list = "\n".join([f"- {song['name']} - {', '.join(song['singer_names'])}" for song in completed_songs[:5]])
        if len(completed_songs) > 5:
            song_list += f"\n... 等共 {len(completed_songs)} 首"

        message = f"歌单名称: {playlist_name}\n本次更新已下载完成: {len(completed_songs)}首\n\n{song_list}\n\n完成时间: {time.strftime('%Y-%m-%d %H:%M:%S')}"
        return await self.send_notification(message, "歌单更新下载完成")

    async def send_login_expired_notification(self, message: str) -> Dict[str, bool]:
        """发送登录状态失效通知

        Args:
            message: 失效原因

        Returns:
            Dict[str, bool]: 各渠道发送结果
        """
        content = f"QQ 音乐登录状态已失效，无法继续下载。\n\n原因: {message}\n\n时间: {time.strftime('%Y-%m-%d %H:%M:%S')}"
        return await self.send_notification(content, "登录状态已失效")

    async def close(self):
        """关闭所有HTTP客户端"""
        for client in self._clients.values():
            await client.aclose()
        self._clients.clear()

# 创建全局通知管理器实例
notification_manager = NotificationManager()

# 示例使用
async def main():
    """示例函数，演示如何使用通知管理器"""
    # 发送普通通知
    result = await notification_manager.send_notification("这是一条测试通知", "测试标题")
    print(f"通知发送结果: {result}")
    
    # 发送下载完成通知
    result = await notification_manager.send_download_complete_notification("测试歌曲", "无损音质")
    print(f"下载完成通知发送结果: {result}")
    
    # 发送歌单更新通知
    new_songs = [
        {"name": "歌曲1", "singer": [{"name": "歌手1"}]},
        {"name": "歌曲2", "singer": [{"name": "歌手2"}]}
    ]
    result = await notification_manager.send_playlist_update_notification("测试歌单", new_songs)
    print(f"歌单更新通知发送结果: {result}")
    
    await notification_manager.close()

if __name__ == "__main__":
    asyncio.run(main())