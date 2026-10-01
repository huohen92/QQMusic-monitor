import os
import json
from typing import Dict, Any

CONFIG_FILE = os.path.join("data", "config.json")

# 应用版本与项目主页（配置页展示用；升级版本只改这里）
APP_VERSION = "0.9.3"
GITHUB_URL = "https://github.com/huohen92/QQMusic-monitor"

# 默认配置
DEFAULT_CONFIG = {
    "app": {
        "host": "0.0.0.0",
        "port": 6696
    },
    "download": {
        "max_concurrent": 5,
        "retry_interval_seconds": 24 * 3600,
        "default_dir": "/app/downloads/save",
        "downloads_root": "/app/downloads",
        "write_tags": True,
        "write_cover": True,
        "write_lyrics": True,
        "lyric_include_normal": True,
        "lyric_include_qrc": False,
        "lyric_include_trans": True,
        "lyric_write_tag": True,
        "lyric_write_lrc": True,
        # OGG 转 MP3：优先下载 QQ 原生 MP3（无损及以上仍优先），避免产出 .ogg
        "prefer_mp3": False,
        "quality_order": ["MASTER", "ATMOS_51", "ATMOS_2", "FLAC", "OGG_640", "OGG_320", "MP3_320", "ACC_192", "OGG_192", "MP3_128", "ACC_96", "OGG_96", "ACC_48"]
    },
    "monitor": {
        "check_interval_seconds": 1800
    },
    "notification": {
        "webhook": {
            "enabled": False,
            "url": ""
        },
        "bark": {
            "enabled": False,
            "server_url": "https://api.day.app",
            "device_key": ""
        },
        "wecom": {
            "enabled": False,
            "webhook_url": ""
        }
    }
}

class ConfigManager:
    def __init__(self):
        import copy as _copy

        # 深拷贝，避免加载配置时污染 DEFAULT_CONFIG 本身
        self._config = _copy.deepcopy(DEFAULT_CONFIG)
        self._load_config()
    
    def _load_config(self):
        """从文件加载配置"""
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                    file_config = json.load(f)
                    # 使用深度合并，保留未在文件中定义的默认值
                    self._merge_config(self._config, file_config)
            except (json.JSONDecodeError, IOError) as e:
                print(f"加载配置文件失败: {e}，将使用默认配置")
        
        # 从环境变量加载配置，优先级高于文件配置
        self._load_env_config()
    
    def _load_env_config(self):
        """从环境变量加载配置"""
        # 支持的环境变量映射
        env_mapping = {
            "MAX_CONCURRENT_DOWNLOADS": "download.max_concurrent",
            "PROXY_URL": "proxy.url"
        }
        
        for env_key, config_path in env_mapping.items():
            env_value = os.environ.get(env_key)
            if env_value is not None:
                # 尝试转换为合适的类型
                try:
                    # 尝试转换为整数
                    value = int(env_value)
                except ValueError:
                    # 尝试转换为布尔值
                    if env_value.lower() in ["true", "false"]:
                        value = env_value.lower() == "true"
                    else:
                        # 保留字符串类型
                        value = env_value
                
                self.set(config_path, value)
                print(f"从环境变量加载配置: {env_key} = {env_value} (映射到 {config_path})")
    
    def _merge_config(self, base: Dict[str, Any], override: Dict[str, Any]):
        """深度合并配置"""
        for key, value in override.items():
            if key in base and isinstance(base[key], dict) and isinstance(value, dict):
                self._merge_config(base[key], value)
            else:
                base[key] = value
    
    def save_config(self):
        """保存配置到文件"""
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        try:
            # 根据 DEFAULT_CONFIG 的类型规范化值，避免数字存成字符串导致运行时崩溃
            normalized = self._normalize_types(self._config, DEFAULT_CONFIG)
            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(normalized, f, indent=2, ensure_ascii=False)
            return True
        except IOError as e:
            print(f"保存配置文件失败: {e}")
            return False

    @staticmethod
    def _normalize_types(value, default):
        """递归把 value 中的值转换为 default 对应的类型（数字/布尔）"""
        if isinstance(default, dict) and isinstance(value, dict):
            return {
                k: ConfigManager._normalize_types(value.get(k, dv), dv)
                for k, dv in default.items()
            }
        if isinstance(default, bool):
            if isinstance(value, str):
                return value.lower() in ("true", "1", "yes")
            return bool(value)
        if isinstance(default, int):
            try:
                return int(value)
            except (TypeError, ValueError):
                return default
        if isinstance(default, float):
            try:
                return float(value)
            except (TypeError, ValueError):
                return default
        return value
    
    def get(self, key_path: str, default: Any = None) -> Any:
        """通过点路径获取配置值，例如：'download.max_concurrent'"""
        keys = key_path.split('.')
        value = self._config
        for key in keys:
            if isinstance(value, dict) and key in value:
                value = value[key]
            else:
                return default
        return value
    
    def set(self, key_path: str, value: Any) -> bool:
        """通过点路径设置配置值"""
        keys = key_path.split('.')
        config = self._config
        
        # 遍历到倒数第二个键
        for key in keys[:-1]:
            if key not in config or not isinstance(config[key], dict):
                config[key] = {}
            config = config[key]
        
        # 设置最后一个键的值
        config[keys[-1]] = value
        return self.save_config()
    
    def get_full_config(self) -> Dict[str, Any]:
        """获取完整配置"""
        return self._config.copy()

    def update_config(self, new_config: Dict[str, Any]) -> bool:
        """更新配置"""
        self._merge_config(self._config, new_config)
        return self.save_config()

    def reset_config(self) -> bool:
        """重置配置为默认值并保存"""
        import copy as _copy

        self._config = _copy.deepcopy(DEFAULT_CONFIG)
        # 删除已保存的配置文件，避免下次启动再合并旧值
        try:
            if os.path.exists(CONFIG_FILE):
                os.remove(CONFIG_FILE)
        except OSError as e:
            print(f"删除配置文件失败: {e}")
        return self.save_config()

    def get_default_config(self) -> Dict[str, Any]:
        """获取默认配置"""
        import copy as _copy

        return _copy.deepcopy(DEFAULT_CONFIG)

# 创建全局配置管理器实例
config = ConfigManager()