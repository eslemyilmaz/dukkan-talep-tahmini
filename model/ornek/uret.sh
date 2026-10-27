#!/bin/sh
# Örnek (sentetik) dosyaları yeniden üretir. model/ klasöründen çalıştırın:
#   sh ornek/uret.sh
set -e
python -m dukkan_tahmin sentetik --cikti ornek/urun_gun.csv.gz --urun 20 --tohum 7 \
  --zip ornek/rapor.zip --html-baslangic 2026-10-13
