"""A UI update must not mix current navigation with cached stylesheets."""
import os
import re

from local_test_client import TestClient

import app


def asset_urls(html):
    return re.findall(r'(?:href|src)="(/static/[^"?]+\.(?:css|js)\?v=[0-9a-f]+)"', html)


def test_index_bypasses_legacy_cached_styles_and_revalidates_assets():
    # No lifespan or owner database is needed to serve the frontend.
    client = TestClient(app.app)
    response = client.get('/')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-cache'
    urls = asset_urls(response.text)
    assert len(urls) == len(re.findall(r'(?:href|src)="/static/[^"?]+\.(?:css|js)(?:\?[^"\s]*)?"',
                                      (app.ROOT / 'static/index.html').read_text(encoding='utf-8')))
    assert any('/navigation-layout.css?v=' in url for url in urls)
    navigation_url = next(url for url in urls if '/training-navigation.css?v=' in url)
    css = client.get(navigation_url)
    assert css.status_code == 200
    assert '.mobile-navigation-group>summary' in css.text
    assert css.headers['cache-control'] == 'no-cache'
    cached = client.get(navigation_url, headers={'If-None-Match': css.headers['etag']})
    assert cached.status_code == 304
    assert cached.headers['cache-control'] == 'no-cache'


def test_asset_url_changes_with_content_even_when_file_timestamp_is_preserved(tmp_path, monkeypatch):
    static = tmp_path / 'static'
    static.mkdir()
    (static / 'index.html').write_text(
        '<link href="/static/menu.css?v=legacy"><script src="/static/app.js"></script>', encoding='utf-8')
    css = static / 'menu.css'
    css.write_text('.mobile-navigation{display:block}', encoding='utf-8')
    (static / 'app.js').write_text('export const menu = true;', encoding='utf-8')
    monkeypatch.setattr(app, 'ROOT', tmp_path)
    client = TestClient(app.app)
    before = asset_urls(client.get('/').text)
    assert asset_urls(client.get('/').text) == before
    original = css.stat()
    css.write_text('.mobile-navigation{display:flex;}', encoding='utf-8')
    os.utime(css, ns=(original.st_atime_ns, original.st_mtime_ns))
    after = asset_urls(client.get('/').text)
    assert before[0] != after[0]
    assert before[1] == after[1]


def test_unversioned_modules_and_html_revalidate_without_changing_api_or_image_caching():
    client = TestClient(app.app)
    for path in ('/static/main-navigation.js', '/static/index.html', '/static/site.webmanifest'):
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers['cache-control'] == 'no-cache'
    assert client.get('/api/not-a-real-endpoint').headers['cache-control'] == 'no-store'
    image = client.get('/static/icons/chessgym-32.png?v=1')
    assert image.status_code == 200
    assert 'cache-control' not in image.headers
