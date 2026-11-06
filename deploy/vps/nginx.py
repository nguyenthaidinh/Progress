#!/usr/bin/env python3
"""Generate the scoped VPS vhost and CSP hashes from the actual static export."""
import argparse
import base64
import hashlib
from html.parser import HTMLParser
from pathlib import Path
import re


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.active = False
        self.parts = []
        self.hashes = set()

    def handle_starttag(self, tag, attrs):
        if tag == 'script':
            self.active = 'src' not in dict(attrs)
            self.parts = []

    def handle_data(self, data):
        if self.active:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == 'script' and self.active:
            body = ''.join(self.parts)
            if body:
                digest = base64.b64encode(hashlib.sha256(body.encode('utf-8')).digest()).decode('ascii')
                self.hashes.add("'sha256-" + digest + "'")
            self.active = False


def safe_path(value):
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', value) or '..' in Path(value).parts:
        raise argparse.ArgumentTypeError('Use an absolute path without shell or nginx syntax')
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--domain', required=True)
    parser.add_argument('--web-root', required=True, type=safe_path)
    parser.add_argument('--asset-root', required=True, type=safe_path)
    parser.add_argument('--relay-port', type=int, default=14320)
    parser.add_argument('--certificate-dir', type=safe_path)
    args = parser.parse_args()
    if not re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}', args.domain) or len(args.domain) > 253:
        parser.error('Invalid hostname')
    if not 1024 <= args.relay_port <= 65535:
        parser.error('Invalid relay port')
    asset_root = Path(args.asset_root)
    if not (asset_root / 'index.html').is_file() or not (asset_root / 'vi/index.html').is_file():
        parser.error('An EN/VI public export is required')
    scripts = Scripts()
    for file in asset_root.rglob('*.html'):
        scripts.feed(file.read_text(encoding='utf-8'))
    csp = "; ".join([
        "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'self'",
        "script-src 'self' " + ' '.join(sorted(scripts.hashes)),
        "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
        "connect-src 'self' https: wss:", "worker-src 'self' blob:", "media-src 'self' data: blob:",
    ])
    if len(csp) > 12000:
        parser.error('CSP header exceeds the release budget')
    common = f'''    server_name {args.domain};
    include /etc/nginx/snippets/lioops-cloudflare-realip.conf;
    client_max_body_size 300k;
    location ^~ /.well-known/acme-challenge/ {{ root /var/www/lioops-acme; }}
'''
    application = f'''    root {args.web_root};
    index index.html;
    access_log off;
    error_log /var/log/nginx/lioops-error.log warn;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Content-Security-Policy "{csp}" always;
    add_header Cache-Control $lioops_html_cache_control always;
    location = /healthz {{ default_type application/json; return 200 '{{"ok":true,"app":"LioOps","mode":"observation"}}'; }}
    location = /relay-health {{
        proxy_pass http://127.0.0.1:{args.relay_port}/health;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Host $host;
    }}
    location /v1/ {{
        proxy_pass http://127.0.0.1:{args.relay_port};
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 25s;
        proxy_send_timeout 25s;
    }}
    location ^~ /_next/static/ {{
        expires 1y;
        try_files $uri =404;
    }}
    location ~ /\\.(?!well-known/) {{ return 404; }}
    location / {{
        expires -1;
        try_files $uri $uri/ =404;
    }}
'''
    # Prevent edge-injected analytics from changing the exported HTML or its script policy.
    # Empty values do not add a header to relay JSON, whose own no-store policy remains authoritative.
    print('map $sent_http_content_type $lioops_html_cache_control {\n    default "";\n    ~^text/html "public, no-cache, no-transform";\n}\n')
    if args.certificate_dir:
        print('server {\n    listen 80;\n    listen [::]:80;\n' + common + '    location / { return 301 https://$host$request_uri; }\n}\n')
        print('server {\n    listen 443 ssl http2;\n    listen [::]:443 ssl http2;\n' + common)
        print(f'    ssl_certificate {args.certificate_dir}/fullchain.pem;\n    ssl_certificate_key {args.certificate_dir}/privkey.pem;')
        print('    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_session_cache shared:LioOpsTLS:1m;\n    add_header Strict-Transport-Security "max-age=15552000" always;')
        print(application + '}')
    else:
        print('server {\n    listen 80;\n    listen [::]:80;\n' + common + application + '}')


if __name__ == '__main__':
    main()
