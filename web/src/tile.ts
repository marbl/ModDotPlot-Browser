export interface NumericTileArrays {
  width: number;
  height: number;
  identity: Uint16Array;
  direction: Int16Array;
  directionSupport: Uint16Array;
}

/** Transposes all row-major scientific channels together for a symmetric self plot. */
export function transposeTile(
  identity: Uint16Array,
  direction: Int16Array,
  directionSupport: Uint16Array,
  width: number,
  height: number,
): NumericTileArrays {
  if (
    identity.length !== width * height ||
    direction.length !== identity.length ||
    directionSupport.length !== identity.length
  ) {
    throw new Error("Tile channels do not match the declared dimensions");
  }
  const transposedIdentity = new Uint16Array(identity.length);
  const transposedDirection = new Int16Array(direction.length);
  const transposedSupport = new Uint16Array(directionSupport.length);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const source = row * width + column;
      const destination = column * height + row;
      transposedIdentity[destination] = identity[source] ?? 0;
      transposedDirection[destination] = direction[source] ?? 0;
      transposedSupport[destination] = directionSupport[source] ?? 0;
    }
  }
  return {
    width: height,
    height: width,
    identity: transposedIdentity,
    direction: transposedDirection,
    directionSupport: transposedSupport,
  };
}
