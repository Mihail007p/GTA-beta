# Авторы, источники и лицензии ресурсов

Игра — неофициальный фанатский проект, не связанный с автопроизводителями.
Модели машин адаптированы для игры: изменены геометрия, материалы, размеры и
структура; производные модели Porsche остаются под CC BY-NC-SA 4.0. Раздача и
использование этой версии с Porsche — **только некоммерческие**. Права на
товарные знаки нужно оценивать отдельно.

| Ресурс в игре | Оригинал и автор | Лицензия |
|---|---|---|
| `assets/cars/cayenne.glb` | [2011 Porsche Cayenne](https://sketchfab.com/3d-models/2011-porsche-cayenne-c781eeb2c0e14f6e94d21feef6b5e7b3), Ddiaz Design | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `assets/cars/gt3.glb` | [2022 Porsche 911 GT3 Touring (992)](https://sketchfab.com/3d-models/2022-porsche-911-gt3-touring-992-a76364a3d50c4d78912a28250cb57be5), Ddiaz Design | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `assets/cars/cgt.glb` | [2004 Porsche Carrera GT](https://sketchfab.com/3d-models/2004-porsche-carrera-gt-9d48aa751ab24becbf7110e93c8a7a1f), OUTPISTON | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `assets/cars/f458.glb` | [Ferrari 458 Italia](https://sketchfab.com/models/57bf6cc56931426e87494f554df1dab6), vicent091036, [пример three.js](https://github.com/mrdoob/three.js/blob/r169/examples/webgl_materials_car.html); страница оригинала может быть недоступна | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); [учёт лицензий three.js](https://github.com/mrdoob/three.js/issues/23089) |
| `assets/traffic.glb` | [Free Low Poly Vehicles Pack](https://rgsdev.itch.io/free-low-poly-vehicles-pack), RgsDev | CC0 1.0; преобразован и адаптирован |
| `assets/characters/*.glb` | MakeHuman system assets через [HumanGenWeb](https://github.com/NastyFFM/HumanGenWeb/tree/a8ee33f96791ed15534246ac88cc8b20f9da8f6a) | CC0 согласно исходным проектам; настроены для игры, см. [подробности](assets/characters/README.md) |
| `assets/characters/motion.json` | [CMU Graphics Lab Motion Capture Database](https://github.com/una-dinosauria/cmu-mocap), данные 07_01 и 09_01 | [условия CMU](https://github.com/una-dinosauria/cmu-mocap/blob/09a07f54f3bbb58797325f009282d0b2048a2871/READMEFIRST.txt); преобразованы |

Porsche-модели получены через [zaqifathis/Porsche](https://github.com/zaqifathis/Porsche/blob/master/LICENSE), где также сохранены сведения об оригиналах и условиях. Их GLB дополнительно содержит авторство и ссылку на лицензию.

> The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.

Зависимости: three.js r169 — MIT, `vendor/THREE-LICENSE.txt`; meshoptimizer decoder 0.18 — MIT, `vendor/MESHOPT-LICENSE.txt`. Изменения импортов в модулях three.js и дальнейшая оптимизация моделей выполнены для локальной работы игры. Эти условия не заменяют отдельные лицензии графических ресурсов.
