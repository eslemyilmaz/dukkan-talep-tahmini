@echo off
cd /d "%~dp0"
py -3 --version >nul 2>&1
if not errorlevel 1 (
    py -3 baslat.py
    goto end
)
python --version >nul 2>&1
if not errorlevel 1 (
    python baslat.py
    goto end
)
echo Python 3 bulunamadi. Python 3 kurulu bir bilgisayarda deneyin.
echo Alternatif: ONCE_OKUYUN.txt icindeki canli uygulama baglantisini acin.
pause
:end
