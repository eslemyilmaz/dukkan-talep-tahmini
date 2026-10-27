"""Dukkan prototipini yalnizca bu bilgisayarda acar. Python 3 gerekir."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import os
import threading
import webbrowser


class DukkanHandler(SimpleHTTPRequestHandler):
    """PWA dosyalari icin dogru MIME turlerini de bilen dosya sunucusu."""

    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.webmanifest': 'application/manifest+json',
        '.json': 'application/json',
        '.js': 'text/javascript',
        '.svg': 'image/svg+xml',
    }


def main():
    os.chdir(Path(__file__).resolve().parent)
    address = ('127.0.0.1', 8765)
    try:
        server = ThreadingHTTPServer(address, DukkanHandler)
    except OSError:
        print('8765 portu kullaniliyor. Onceki Dukkan penceresini kapatip tekrar deneyin.')
        input('Cikmak icin Enter...')
        return
    url = 'http://127.0.0.1:8765/'
    print('Dukkan uygulamasi: ' + url)
    print('Uygulama acikken bu pencereyi kapatmayin. Durdurmak icin Ctrl+C.')
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
