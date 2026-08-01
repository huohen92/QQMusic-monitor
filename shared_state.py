# shared_state.py

"""
用于在应用程序的不同模块之间共享状态的中央模块。
"""

# 这个字典将保存所有下载任务的状态。
# 键是 song_mid，值是包含任务信息的字典。
# 例如：
# {
#     "song_mid_123": {
#         "status": "downloading",
#         "song_name": "歌曲名称",
#         "quality": "high",
#         "progress": 50,
#         "error": None,
#         "file_path": "/path/to/song.mp3",
#         "url": "/downloads/song.mp3"
#     }
# }
download_tasks = {}

# 监控歌单新增歌曲的下载完成待通知状态。
# 键: playlist_id (str)
# 值: {"title": 歌单名, "songs": {mid: {"name": str, "singer_names": [str]}}}
# 用于"歌单更新部分下载完成"通知。
pending_completion = {}
