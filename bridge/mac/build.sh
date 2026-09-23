#!/bin/sh
# Собирает lookup-bridge и «LookUp Bridge.app». Нужны Xcode Command Line Tools (xcode-select --install).
set -e
cd "$(dirname "$0")"
swiftc -O main.swift -o lookup-bridge \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
codesign -s - --force lookup-bridge

# вариант «приложением»: разрешение на движение запрашивается для самого приложения, а не для Terminal
APP="LookUp Bridge.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp lookup-bridge "$APP/Contents/MacOS/lookup-bridge"
cp Info.plist "$APP/Contents/Info.plist"
codesign -s - --force --deep "$APP"

echo "Готово."
echo "  Запуск из терминала:  ./lookup-bridge"
echo "  Если падает или нет запроса на «Движение и фитнес»:  open \"$APP\"  (логи: open --stdout /tmp/lookup-bridge.log \"$APP\")"
