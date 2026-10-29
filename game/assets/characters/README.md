# Происхождение персонажей и движений

## Персонажи

`hero-1.glb`, `hero-2.glb`, варианты костюмов `hero-1-smart.glb` /
`hero-2-smart.glb` и два персонажа `citizen-1.glb` / `citizen-2.glb` —
настроенные специально для этой игры варианты,
**сгенерированные на основе готовых данных MakeHuman**, а не полностью
смоделированные с нуля. Для создания использовался
[HumanGenWeb](https://github.com/NastyFFM/HumanGenWeb/tree/a8ee33f96791ed15534246ac88cc8b20f9da8f6a)
(ревизия `a8ee33f96791ed15534246ac88cc8b20f9da8f6a`), с пресетами из
[`tools/character-presets/`](../../tools/character-presets/). Базовые сетка,
морфы и риг происходят от MakeHuman/mpfb2; выбранные кожа, глаза, брови,
ресницы, волосы, одежда и обувь — из набора, который HumanGenWeb описывает
как MakeHuman CC0 system assets. Пресеты и патч для экспорта сохранены в проекте.

- `hero-1`: кожа `young_caucasian_male`, волосы `short01`, одежда
  `male_casualsuit03` и `shoes01`.
- `hero-2`: кожа `young_caucasian_female`, волосы `ponytail01`, одежда
  `female_casualsuit02` и `shoes03`.
- `hero-1-smart` и `hero-2-smart`: те же параметры героев с `male_elegantsuit01` /
  `female_elegantsuit01` и подходящей обувью.
- `citizen-1`: `middleage_african_male`, `short03`, `male_worksuit01`;
  используется для прохожих и продавца. `citizen-2`: `middleage_asian_female`,
  `bob02`, `female_sportsuit01`; используется для прохожих.

[Условия MakeHuman](https://github.com/makehumancommunity/makehuman/blob/master/makehuman/license.txt)
отдельно определяют исходный код программы (AGPL) и её встроенные графические
ассеты (CC0 1.0); для результатов из этих встроенных данных проект не заявляет
прав. [README HumanGenWeb](https://github.com/NastyFFM/HumanGenWeb/tree/a8ee33f96791ed15534246ac88cc8b20f9da8f6a#licence)
указывает CC0 для сетки и целей, MIT для кода генератора и происхождение
остальных элементов из CC0-пакета. Код MakeHuman в игру не включён. Если в
будущем добавлять другие, отдельно скачанные ассеты, их лицензии нужно проверять
индивидуально — они могут быть иными.

Каждая модель содержит риг на 53 кости. GLB оптимизированы meshopt и WebP;
оригинальные исходники генератора и текстуры в игру не включены. Значения
`WEIGHTS_0` во всех шести оптимизированных моделях проверены на неотрицательность и
нормировку. Проверка glTF не сообщила ошибок, но выдала предупреждения о
расчётных тангентах и вложенных skinned-mesh; встроенный валидатор не проверяет
расширение meshopt. Поэтому модели дополнительно проверены игровым загрузчиком.

## Анимации

`motion.json` содержит преобразованные кватернионы из базы
[CMU Graphics Lab Motion Capture Database](http://mocap.cs.cmu.edu/),
MotionBuilder-совместимая BVH-конверсия Bruce Hahne, зеркало
[una-dinosauria/cmu-mocap](https://github.com/una-dinosauria/cmu-mocap/tree/09a07f54f3bbb58797325f009282d0b2048a2871).
Использованы `07_01.bvh` (ходьба) и `09_01.bvh` (бег), с выбранными
циклическими отрезками и разрежением кадров. Исходный FPS — 120; созданная
нами в игре анимация idle и поправки рук, плеч и головы находятся в
`js/hero-model.js`. CMU/Bruce Hahne разрешают применение этих данных в
исследовательских и коммерческих проектах; см.
[READMEFIRST](https://github.com/una-dinosauria/cmu-mocap/blob/09a07f54f3bbb58797325f009282d0b2048a2871/READMEFIRST.txt).
Просимое ими упоминание:

> The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.

Эти разрешения касаются персонажей и движений, а **не всей игры**: некоторые
существующие модели Porsche распространяются по CC BY-NC-SA 4.0 и требуют
отдельной проверки перед коммерческим использованием.
