export class RotationMapper {
  rotation: number = 0;

  width: number = 0;
  height: number = 0;

  logicalWidth: number = 0;
  logicalHeight: number = 0;

  x: number = 0;
  y: number = 0;

  logicalX: number = 0;
  logicalY: number = 0;

  setSize(width: number, height: number) {
    const oldLogicalWidth = this.logicalWidth || width;
    const oldLogicalHeight = this.logicalHeight || height;

    this.width = width;
    this.height = height;

    this.updateLogicalSize();

    this.x = (this.x / oldLogicalWidth) * this.logicalWidth;
    this.y = (this.y / oldLogicalHeight) * this.logicalHeight;
    this.logicalX = this.x;
    this.logicalY = this.y;
  }

  setRotation(rotation: number) {
    this.rotation = rotation;
    this.updateLogicalSize();
  }

  private updateLogicalSize() {
    this.logicalX = this.x;
    this.logicalY = this.y;

    if (this.rotation === 1 || this.rotation === 3) {
      this.logicalWidth = this.height;
      this.logicalHeight = this.width;
    } else {
      this.logicalWidth = this.width;
      this.logicalHeight = this.height;
    }
  }

  setLogicalPosition(lx: number, ly: number) {
    this.logicalX = lx;
    this.logicalY = ly;

    if (this.rotation === 0) {
      this.x = lx;
      this.y = ly;
    } else if (this.rotation === 1) { // 90 degrees clockwise
      this.x = ly;
      this.y = this.height - lx;
    } else if (this.rotation === 2) { // 180 degrees
      this.x = this.width - lx;
      this.y = this.height - ly;
    } else if (this.rotation === 3) { // 270 degrees clockwise
      this.x = this.width - ly;
      this.y = lx;
    }
  }
}
