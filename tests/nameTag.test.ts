import { describe, expect, test } from 'bun:test';
import { keepTagLegible } from '../src/client/r3d/aim3d.ts';
import { PerspectiveCamera, Sprite, Vector3 } from '../src/client/r3d/three.ts';

// A camera 40 m behind the tag, looking at it.
function scene(canvasH: number, height: number) {
  const cam = new PerspectiveCamera(30, 1.5, 0.1, 500);
  cam.position.set(0, 0, 40);
  cam.lookAt(new Vector3());
  cam.updateMatrixWorld();
  const sp = new Sprite();
  sp.scale.set(height * 4, height, 1);
  sp.updateMatrixWorld();
  const px = () => (sp.scale.y * canvasH) / (2 * 40 * Math.tan((15 * Math.PI) / 180));
  keepTagLegible.call(sp, { domElement: { clientHeight: canvasH } as HTMLCanvasElement }, null, cam);
  return { sp, px: px() };
}

describe('name tag size', () => {
  test('a tag the camera would draw tiny grows to the minimum, keeping its shape', () => {
    const { sp, px } = scene(360, 0.4);
    expect(px).toBeCloseTo(21, 0);
    expect(sp.scale.x / sp.scale.y).toBeCloseTo(4, 5);
  });
  test('a tag already big enough is left alone', () => {
    const { sp } = scene(800, 2);
    expect(sp.scale.y).toBe(2);
  });
});
