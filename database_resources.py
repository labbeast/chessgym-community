"""Reference resource catalogue: automated feeds and browser-authorized imports."""
from lumbra_resources import LumbraResources
from resource_downloads import LichessResources


class DatabaseResources:
    def __init__(self, data_root):
        self.lichess = LichessResources(data_root)
        self.lumbra = LumbraResources(data_root)

    def catalog(self):
        return self.lichess.catalog() + self.lumbra.catalog()

    def install(self, resource_id, progress, *, source_path=None):
        if resource_id.startswith('lumbra-'):
            return self.lumbra.install(resource_id, progress, source_path=source_path)
        if source_path is not None:
            raise ValueError('Cette ressource ne peut pas être importée depuis une archive locale.')
        return self.lichess.install(resource_id, progress)
