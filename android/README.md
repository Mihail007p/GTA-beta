# Open Street для Android

Android-приложение — автономная оболочка WebView для игры из `../game/`. Оно
упаковывает игровые модели и код внутрь APK, не требует сервера и при обычной
игре не нуждается в сети. Страницы и ресурсы отдаются из APK на стабильном
origin `https://appassets.androidplatform.net/game/`; внешняя навигация
заблокирована, кроме нажатых ссылок на авторов, которые открываются в системном
браузере. `INTERNET` требуется WebView для HTTPS-origin, `VIBRATE` — для
вибрации в игре. Встроенного JavaScript-моста, аналитики и сервера нет.

В Android-режиме Service Worker не регистрируется: обновление APK сразу видит
его собственные файлы, без старого кэша. Прогресс хранится в localStorage
приложения и **не переносится автоматически из браузерной версии**. При
удалении приложения локальные данные могут быть потеряны. Аппаратное ускорение
включено, экран — горизонтальный immersive; для 3D нужен работающий WebGL 2 в
актуальном Android System WebView. Минимальная версия — Android 6 (API 23),
целевая — Android 14 (API 34); реальная совместимость зависит от устройства и
версии WebView.

## Сборка в Android Studio или Gradle

Нужны JDK 17, Android SDK Platform 34 и Android Gradle Plugin 8.2.2. Из папки
`android/`:

```sh
./gradlew assembleDebug
# Для подписанного релиза — только с приватными файлами ВНЕ репозитория:
export OPENSTREET_KEYSTORE=/закрытый/путь/openstreet-release.p12
export OPENSTREET_STOREPASS_FILE=/закрытый/путь/password.txt
export OPENSTREET_KEY_ALIAS=openstreet-release
./gradlew assembleRelease
```

Без обеих переменных подписи `assembleRelease` выдаёт неподписанный APK.
Пароль хранится в отдельном текстовом файле; путь к нему и сам ключ нельзя
коммитить или публиковать. Для каждого обновления повышайте `VERSION_CODE` в
`version.properties` и подписывайте APK **тем же ключом и alias**: иначе
Android не установит обновление поверх этой версии. Идентификатор приложения
`ru.openstreet.game` и HTTPS-origin менять нельзя без плана переноса данных.

Внешние SDK-зависимости Gradle загружаются стандартными репозиториями Google и
Maven. `gradle-wrapper.jar` взят из Gradle 8.2.1, его SHA-256 —
`a8451eeda314d0568b5340498b36edf147a8f0d692c5ff58082d477abe9146e4`;
контрольная сумма дистрибутива указана в `gradle-wrapper.properties`.

## Минимальная сборка без Gradle

`tools/build-release.sh` собирает тот же проект через aapt2, ECJ, D8 и
apksigner; Python-скрипт выравнивает несжатые ZIP-записи перед подписью.
Инструменты **не находятся** в репозитории и задаются переменными `JAVA`,
`AAPT2`, `ANDROID_JAR`, `ECJ_JAR`, `D8_JAR`, `APKSIGNER_JAR`, `KEYSTORE` и
`STOREPASS_FILE`. `KEYSTORE` и `STOREPASS_FILE` обязаны лежать вне репозитория.
Сборка проверяет подписи v1/v2/v3 и выравнивание. Для релиза v0.13.0
использованы временные инструменты из npm-пакетов `aaptjs3@2.0.2` (Linux aapt2,
SHA-256 `e4dff6060827a3e401bce376e47916f2f93a89602af54973ffd3fdfc2528be3f`)
и `@drxiaozhi/minapk@0.5.1` (android.jar API 34,
`6cea1df3efb77103ac3e2beb9bf4718964b0e0869ab16d39d29d5cbae1c147ad`;
D8 `d43c8a94c9b1f1da1a7cc49c32b81e8cee1708b37ee8b530a81a0688222b42c0`;
apksigner `eefdd6aed9db9fb849e4c98a50d8741e19d1b674ba6547220bcb9c3ed152123a`;
ECJ 3.45.0 `c8f5e66787ea6e4e0394ba3051c86a4edc50683ce9850f71739646529a99a2d7`).
По описанию minapk три Android JAR идентичны файлам SDK Google; Linux aapt2
получен из сторонней упаковки, а не скачан здесь напрямую у Google.

## Проверка

- `AssetPolicyTest.java` запускается обычной JVM и проверяет маршруты, MIME и запрет обхода путей.
- `tools/verify-apk-assets.py ПУТЬ.apk` сверяет все файлы игры с APK и их контрольные суммы.
- `npm run android-assets` из `game/tests/e2e/` извлекает ресурсы подписанного APK и проверяет игру, управление, паузу, сохранения и отсутствие удалённых запросов в Chromium. Это **не** тест Android WebView, APK-установщика или реального телефона.
- На физическом устройстве дополнительно проверьте установку, звук, полноэкранный режим, касания, сохранение после перезапуска и работу без сети. На момент выпуска v0.13.0 телефон/эмулятор Android в среде сборки не были доступны.

Авторы, источники и лицензии ресурсов: [ASSET-CREDITS.md](../game/ASSET-CREDITS.md).
Некоторые модели распространяются по CC BY-NC-SA 4.0: эта версия не предназначена для коммерческого использования.
