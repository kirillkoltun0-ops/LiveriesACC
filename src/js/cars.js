// Справочник кузовов ACC: carModelType → название + ключевые слова для поиска 3D-модели.
// Если у вашей лиги ID отличаются — правьте только этот файл.
export const CARS = [
  { id: 0,  name: 'Porsche 991 GT3 R (2018)',          k: ['porsche', '991', 'gt3', 'r'], y: '2018' },
  { id: 1,  name: 'Mercedes-AMG GT3 (2015)',           k: ['mercedes', 'amg', 'gt3'], y: '2015' },
  { id: 2,  name: 'Ferrari 488 GT3 (2018)',            k: ['ferrari', '488', 'gt3'], y: '2018' },
  { id: 3,  name: 'Audi R8 LMS (2015)',                k: ['audi', 'r8', 'lms'], y: '2015' },
  { id: 4,  name: 'Lamborghini Huracán GT3 (2015)',    k: ['lamborghini', 'huracan', 'gt3'], y: '2015' },
  { id: 5,  name: 'McLaren 650S GT3 (2015)',           k: ['mclaren', '650s'], y: '2015' },
  { id: 6,  name: 'Nissan GT-R Nismo GT3 (2018)',      k: ['nissan', 'gt-r', 'gtr', 'nismo'], y: '2018' },
  { id: 7,  name: 'BMW M6 GT3 (2017)',                 k: ['bmw', 'm6'], y: '2017' },
  { id: 8,  name: 'Bentley Continental GT3 (2018)',    k: ['bentley', 'continental'], y: '2018' },
  { id: 9,  name: 'Porsche 991 II GT3 Cup (2017)',     k: ['porsche', '991', 'cup'], y: '2017' },
  { id: 10, name: 'Nissan GT-R Nismo GT3 (2015)',      k: ['nissan', 'gt-r', 'gtr', 'nismo'], y: '2015' },
  { id: 11, name: 'Bentley Continental GT3 (2015)',    k: ['bentley', 'continental'], y: '2015' },
  { id: 12, name: 'Aston Martin V12 Vantage GT3 (2013)', k: ['aston', 'v12', 'vantage'], y: '2013' },
  { id: 13, name: 'Lamborghini Gallardo R-EX (2017)',  k: ['lamborghini', 'gallardo'], y: '2017' },
  { id: 14, name: 'Jaguar G3 (2012)',                  k: ['jaguar', 'g3'], y: '2012' },
  { id: 15, name: 'Lexus RC F GT3 (2016)',             k: ['lexus', 'rc'], y: '2016' },
  { id: 16, name: 'Lamborghini Huracán Evo (2019)',    k: ['lamborghini', 'huracan', 'evo', 'gt3'], y: '2019' },
  { id: 17, name: 'Honda NSX GT3 (2017)',              k: ['honda', 'nsx'], y: '2017' },
  { id: 18, name: 'Lamborghini Huracán Super Trofeo',  k: ['lamborghini', 'huracan', 'trofeo'], y: '2015' },
  { id: 19, name: 'Audi R8 LMS Evo (2019)',            k: ['audi', 'r8', 'evo'], y: '2019' },
  { id: 20, name: 'AMR V8 Vantage (2019)',             k: ['amr', 'v8', 'vantage', 'gt3'], y: '2019' },
  { id: 21, name: 'Honda NSX Evo (2019)',              k: ['honda', 'nsx', 'evo'], y: '2019' },
  { id: 22, name: 'McLaren 720S GT3 (2019)',           k: ['mclaren', '720s', 'gt3'], y: '2019' },
  { id: 23, name: 'Porsche 911 II GT3 R (2019)',       k: ['porsche', '911', 'gt3', 'r'], y: '2019' },
  { id: 24, name: 'Ferrari 488 GT3 Evo (2020)',        k: ['ferrari', '488', 'evo'], y: '2020' },
  { id: 25, name: 'Mercedes-AMG GT3 Evo (2020)',       k: ['mercedes', 'amg', 'evo', 'gt3'], y: '2020' },
  { id: 26, name: 'Ferrari 488 Challenge Evo',         k: ['ferrari', '488', 'challenge'], y: '2020' },
  { id: 27, name: 'BMW M2 Club Sport Racing',          k: ['bmw', 'm2'], y: '2020' },
  { id: 28, name: 'Porsche 992 GT3 Cup (2021)',        k: ['porsche', '992', 'cup'], y: '2021' },
  { id: 29, name: 'Lamborghini Huracán ST Evo2',       k: ['lamborghini', 'huracan', 'trofeo', 'evo2'], y: '2021' },
  { id: 30, name: 'BMW M4 GT3 (2021)',                 k: ['bmw', 'm4', 'gt3'], y: '2021' },
  { id: 31, name: 'Audi R8 LMS GT3 Evo II (2022)',     k: ['audi', 'r8', 'evo', 'ii'], y: '2022' },
  { id: 32, name: 'Ferrari 296 GT3 (2023)',            k: ['ferrari', '296'], y: '2023' },
  { id: 33, name: 'Lamborghini Huracán GT3 Evo2 (2023)', k: ['lamborghini', 'huracan', 'evo2', 'gt3'], y: '2023' },
  { id: 34, name: 'Porsche 992 GT3 R (2023)',          k: ['porsche', '992', 'gt3', 'r'], y: '2023' },
  { id: 35, name: 'McLaren 720S GT3 Evo (2023)',       k: ['mclaren', '720s', 'evo'], y: '2023' },
  { id: 36, name: 'Ford Mustang GT3 (2024)',           k: ['ford', 'mustang'], y: '2024' },
  { id: 50, name: 'Alpine A110 GT4',                   k: ['alpine', 'a110'], y: '' },
  { id: 51, name: 'Aston Martin Vantage GT4',          k: ['aston', 'vantage', 'gt4'], y: '' },
  { id: 52, name: 'Audi R8 LMS GT4',                   k: ['audi', 'r8', 'gt4'], y: '' },
  { id: 53, name: 'BMW M4 GT4',                        k: ['bmw', 'm4', 'gt4'], y: '' },
  { id: 55, name: 'Chevrolet Camaro GT4.R',            k: ['chevrolet', 'camaro'], y: '' },
  { id: 56, name: 'Ginetta G55 GT4',                   k: ['ginetta', 'g55'], y: '' },
  { id: 57, name: 'KTM X-Bow GT4',                     k: ['ktm', 'bow'], y: '' },
  { id: 58, name: 'Maserati MC GT4',                   k: ['maserati'], y: '' },
  { id: 59, name: 'McLaren 570S GT4',                  k: ['mclaren', '570s'], y: '' },
  { id: 60, name: 'Mercedes-AMG GT4',                  k: ['mercedes', 'amg', 'gt4'], y: '' },
  { id: 61, name: 'Porsche 718 Cayman GT4 MR',         k: ['porsche', '718', 'cayman'], y: '' },
];

export const carName = (id) => CARS.find((c) => c.id === Number(id))?.name ?? (id == null ? 'Неизвестный кузов' : `Кузов #${id}`);

const norm = (s) => s.toLowerCase().replace(/[áàä]/g, 'a').replace(/[^a-z0-9\-. ]+/g, ' ');

/** Оценка совпадения имени файла модели с карточкой кузова (0..~1.2). */
function score(car, fileName) {
  const f = ' ' + norm(fileName).replace(/\.(obj|glb|gltf)$/, '') + ' ';
  const has = (kw) => f.includes(kw) || (kw === 'gt-r' && f.includes('gtr')) || (kw === 'gtr' && f.includes('gt-r'));
  // «сильные» токены (991, 488, 720s, v12, m4…) обязательны: иначе 991 R подойдёт к модели 992 R
  const strong = car.k.filter((t) => /\d/.test(t) && !/^(gt[34]|evo2)$/.test(t));
  if (strong.some((t) => !has(t))) return 0;
  const hits = car.k.filter(has).length;
  if (!hits) return 0;
  let s = hits / car.k.length;
  if (car.y && f.includes(car.y)) s += 0.15;
  // «gt4» в имени файла не должен подходить GT3-кузовам и наоборот
  const gt4 = /gt4/.test(f), carGt4 = car.id >= 50;
  if (gt4 !== carGt4) s -= 0.6;
  if (/\bevo ?2\b|evo2/.test(f) !== /evo2/.test(car.k.join(' '))) s -= 0.1;
  return s;
}

/** Подбирает .obj/.glb из репозитория под carModelType. Возвращает model или null. */
export function matchModel(carModelType, models) {
  const car = CARS.find((c) => c.id === Number(carModelType));
  if (!car || !models?.length) return null;
  let best = null, bestScore = 0;
  for (const m of models) {
    // .obj предпочтительнее .glb при равенстве (по ТЗ основной формат)
    const s = score(car, m.name) + (/\.obj$/i.test(m.name) ? 0.01 : 0);
    if (s > bestScore) { best = m; bestScore = s; }
  }
  return bestScore >= 0.5 ? best : null;
}
