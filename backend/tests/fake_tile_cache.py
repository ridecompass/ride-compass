"""`tile_cache`（同期的なディスクI/O）の差し替え。"""


class FakeTileCache:
    def __init__(self):
        self.entries = {}

    def get(self, path):
        return self.entries.get(path)

    def set(self, path, content, content_type):
        self.entries[path] = (content, content_type)
