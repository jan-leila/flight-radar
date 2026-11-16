// A minimal Mapbox Vector Tile encoder for the tests of src/common/tiles.js.

function varint(v) {
  const out = [];
  while (v >= 128) { out.push((v % 128) + 128); v = Math.floor(v / 128); }
  out.push(v);
  return out;
}
const zigzag = d => (d >= 0 ? d * 2 : -d * 2 - 1);
const bytesField = (number, bytes) => [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
const intField = (number, v) => [...varint(number * 8), ...varint(v)];
const text = s => [...Buffer.from(s, 'utf8')];

// lines: [[[x, y], ...], ...] in tile units
function geometry(lines) {
  const out = [];
  let cx = 0;
  let cy = 0;
  const step = ([x, y]) => { out.push(...varint(zigzag(x - cx)), ...varint(zigzag(y - cy))); cx = x; cy = y; };
  for (const line of lines) {
    out.push(...varint(1 * 8 + 1));
    step(line[0]);
    out.push(...varint((line.length - 1) * 8 + 2));
    line.slice(1).forEach(step);
  }
  return out;
}

// layers: [{name, extent?, features: [{type? (2 = line), props: {key: string | number}, lines}]}]
// keysFirst: write the layer's keys and values before its features (encoders differ)
function tile(layers, keysFirst) {
  const out = [];
  for (const layer of layers) {
    const keys = [];
    const values = [];
    const features = layer.features.map(f => {
      const tags = [];
      for (const [k, v] of Object.entries(f.props || {})) {
        if (!keys.includes(k)) keys.push(k);
        let i = values.findIndex(x => x === v);
        if (i < 0) i = values.push(v) - 1;
        tags.push(...varint(keys.indexOf(k)), ...varint(i));
      }
      return bytesField(2, [
        ...intField(1, 7), ...bytesField(2, tags), ...intField(3, f.type === undefined ? 2 : f.type),
        ...bytesField(4, geometry(f.lines))
      ]);
    });
    const dict = [
      ...keys.flatMap(k => bytesField(3, text(k))),
      ...values.flatMap(v => bytesField(4, typeof v === 'string' ? bytesField(1, text(v)) : intField(4, v)))
    ];
    const body = [
      ...intField(15, 2), ...bytesField(1, text(layer.name)),
      ...(keysFirst ? dict.concat(...features) : [].concat(...features, dict)),
      ...(layer.extent ? intField(5, layer.extent) : [])
    ];
    out.push(...bytesField(3, body));
  }
  return new Uint8Array(out);
}

module.exports = { tile };
