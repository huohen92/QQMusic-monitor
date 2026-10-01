import asyncio
import httpx
import json
import time
import urllib.parse
from typing import Dict, Any, Optional
from config import config


def _split_by_bytes(text: str, max_bytes: int) -> list:
    """按 UTF-8 字节上限分段，优先在换行处断开（渠道通常限制消息字节数）"""
    if len(text.encode("utf-8")) <= max_bytes:
        return [text]
    chunks, current = [], ""
    for line in text.split("\n"):
        candidate = f"{current}\n{line}" if current else line
        if current and len(candidate.encode("utf-8")) > max_bytes:
            chunks.append(current)
            current = line
        else:
            current = candidate
        # 单行自身就超限时硬切
        while len(current.encode("utf-8")) > max_bytes:
            head = current.encode("utf-8")[:max_bytes].decode("utf-8", "ignore")
            if not head:
                head = current[:1]
            chunks.append(head)
            current = current[len(head):]
    if current:
        chunks.append(current)
    return chunks


def _split_by_encoded_len(text: str, max_len: int) -> list:
    """按 URL 编码后的长度分段（Bark 走 GET 路径，受 URL 长度限制）"""
    if len(urllib.parse.quote(text)) <= max_len:
        return [text]
    chunks, current = [], ""
    for line in text.split("\n"):
        candidate = f"{current}\n{line}" if current else line
        if current and len(urllib.parse.quote(candidate)) > max_len:
            chunks.append(current)
            current = line
        else:
            current = candidate
        while len(urllib.parse.quote(current)) > max_len and current:
            lo, hi = 1, len(current)
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if len(urllib.parse.quote(current[:mid])) <= max_len:
                    lo = mid
                else:
                    hi = mid - 1
            chunks.append(current[:lo])
            current = current[lo:]
    if current:
        chunks.append(current)
    return chunks


# 歌单结果汇报里各状态的显示文案
STATUS_LABELS = {
    "completed": "✅已下载",
    "local_exists": "⏭本地已存在，跳过",
    "failed": "❌下载失败",
    "waiting": "⏳等待重试",
    "pending": "⬇️下载中",
    "cancelled": "🚫已取消",
    "unknown": "⬜未下载",
}

STATUS_SUMMARY_ORDER = ["completed", "local_exists", "failed", "waiting", "pending", "cancelled", "unknown"]


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
            # 走 GET 路径，消息过长会超出 URL 长度限制，故分段发送
            import urllib.parse
            encoded_title = urllib.parse.quote(title)
            # 预留 device_key / 域名 / 标题占用的长度
            budget = max(300, 1500 - len(encoded_title))
            chunks = _split_by_encoded_len(message, budget)
            total = len(chunks)
            ok = True
            for index, chunk in enumerate(chunks, 1):
                head = f"({index}/{total})\n" if total > 1 else ""
                encoded_message = urllib.parse.quote(head + chunk)
                url = f"{server_url}/{device_key}/{encoded_title}/{encoded_message}"
                response = await client.get(url)
                response.raise_for_status()
            return ok
        except Exception as e:
            print(f"发送Bark通知失败: {e}")
            return False

    async def _send_wecom(self, message: str, title: str = "QQ音乐下载器通知") -> bool:
        """发送企业微信群机器人通知 (Webhook + 纯文本)

        纯文本无独立标题字段，标题并入 content；企业微信限制 2048 字节，
        超长时按行自动拆成多条依次发送。

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

        client = await self._get_client("wecom")
        content = f"{title}\n{message}"
        # 预留 "(i/N)\n" 与 JSON 包装的余量
        chunks = _split_by_bytes(content, 1750)
        total = len(chunks)
        ok = True
        for index, chunk in enumerate(chunks, 1):
            head = f"({index}/{total})\n" if total > 1 else ""
            payload = {
                "msgtype": "text",
                "text": {"content": head + chunk},
            }
            try:
                response = await client.post(webhook_url, json=payload)
                response.raise_for_status()
            except Exception as e:
                print(f"发送企业微信通知失败({index}/{total}): {e}")
                ok = False
            if index < total:
                await asyncio.sleep(0.3)  # 稍微错开，避免触发频率限制
        return ok

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

    async def send_playlist_update_notification(self, playlist_name: str, new_songs: list, total_count: int = 0) -> Dict[str, bool]:
        """发送歌单更新通知

        Args:
            playlist_name: 歌单名称
            new_songs: 新歌曲列表
            total_count: 歌单当前总曲目数（可选）

        Returns:
            Dict[str, bool]: 各渠道发送结果
        """
        song_list = "\n".join([f"- {song['name']} - {', '.join(s['name'] for s in song['singer'])}" for song in new_songs[:5]])
        if len(new_songs) > 5:
            song_list += f"\n... 等共 {len(new_songs)} 首新歌曲"

        total_line = f"\n歌单共: {total_count}首" if total_count else ""
        message = (
            f"歌单名称: {playlist_name}{total_line}\n新增歌曲: {len(new_songs)}首\n\n{song_list}"
            f"\n\n更新时间: {time.strftime('%Y-%m-%d %H:%M:%S')}"
            f"\n（这批歌曲的下载结果会随后单独汇报）"
        )
        return await self.send_notification(message, "歌单更新提醒")

    async def send_playlist_report_notification(
        self,
        playlist_name: str,
        entries: list,
        stats: dict,
        total_count: int = 0,
        batch_count: int = 0,
        truncated: bool = False,
        still_running: int = 0,
    ) -> Dict[str, bool]:
        """发送歌单完整下载结果（≤50 首，逐条列出状态与未下载原因）

        Args:
            playlist_name: 歌单名称
            entries: [{"index": int, "label": str, "status": str, "detail": str, "in_batch": bool}]
                     status 取 completed/local_exists/failed/waiting/pending/cancelled/unknown
            stats: 各状态计数
            total_count: 歌单总曲目数
            batch_count: 本次新增（入队）曲目数
            truncated: 歌单曲目超过展示上限时为 True
            still_running: 汇报时仍在下载的数量

        Returns:
            Dict[str, bool]: 各渠道发送结果
        """
        summary = " · ".join(
            f"{STATUS_LABELS.get(key, key)} {stats[key]}"
            for key in STATUS_SUMMARY_ORDER
            if stats.get(key)
        )

        lines = []
        for entry in entries:
            label = STATUS_LABELS.get(entry.get("status"), entry.get("status", ""))
            detail = entry.get("detail") or ""
            mark = "🆕" if entry.get("in_batch") else "  "
            detail_text = f"（{detail}）" if detail else ""
            lines.append(f"{entry.get('index', '')}.{mark} {entry.get('label', '')} {label}{detail_text}")

        header = f"歌单名称: {playlist_name}\n歌单共 {total_count} 首"
        if batch_count:
            header += f"（本次新增 {batch_count} 首）"
        if still_running:
            header += f"\n⚠️ 仍有 {still_running} 首在下载中，此处为当前进度"

        message = (
            f"{header}\n结果: {summary}\n\n"
            + "\n".join(lines)
            + (f"\n\n（仅列出歌单前 {len(entries)} 首，歌单实际共 {total_count} 首）" if truncated else "")
            + f"\n\n标记说明: 🆕=本次新增\n汇报时间: {time.strftime('%Y-%m-%d %H:%M:%S')}"
        )
        return await self.send_notification(message, "歌单下载结果")

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