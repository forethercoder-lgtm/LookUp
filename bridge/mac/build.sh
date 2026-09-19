#!/bin/sh
# Собирает lookup-bridge. Нужны Xcode Command Line Tools (xcode-select --install).
set -e
cd "$(dirname "$0")"
swiftc -O main.swift -o lookup-bridge \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
codesign -s - --force lookup-bridge
echo "Готово. Запуск: ./lookup-bridge"
