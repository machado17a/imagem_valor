#!/usr/bin/env python3
"""
Gera ícones PNG simples para a extensão Chrome.
Execute com: python3 create_icons.py
Requer: pip install Pillow
"""

try:
    from PIL import Image, ImageDraw, ImageFont
    USE_PIL = True
except ImportError:
    USE_PIL = False

import struct
import zlib
import os

def create_png_icon(size, filename):
    """Cria um PNG simples com ícone de câmera usando apenas stdlib."""
    # Fundo dourado (#F0C040) com letra V
    # Usamos um PNG mínimo gerado manualmente

    width = height = size
    # Pixels: fundo dourado (#F0C040 = 240, 192, 64)
    bg_r, bg_g, bg_b = 240, 192, 64
    fg_r, fg_g, fg_b = 26, 26, 46  # texto escuro

    # Cria imagem RGBA simples
    pixels = []
    cx, cy = width // 2, height // 2
    r = width // 2 - 1

    for y in range(height):
        row = []
        for x in range(width):
            # Círculo
            dx, dy = x - cx, y - cy
            if dx*dx + dy*dy <= r*r:
                # Letra "V" simplificada no centro
                # Define região do V
                lx = (x - cx) / r  # -1 a 1
                ly = (y - cy) / r  # -1 a 1
                in_v = False
                # Braço esquerdo do V: linha de (-0.5, -0.5) a (0, 0.4)
                # Braço direito do V: linha de (0.5, -0.5) a (0, 0.4)
                thickness = 0.15
                # Normalizado
                if ly > -0.6 and ly < 0.5:
                    # Braço esquerdo
                    slope_l = (0.4 - (-0.5)) / (0.0 - (-0.5))  # dy/dx
                    expected_x_l = -0.5 + (ly - (-0.5)) / slope_l
                    if abs(lx - expected_x_l) < thickness:
                        in_v = True
                    # Braço direito
                    expected_x_r = 0.5 - (ly - (-0.5)) / slope_l
                    if abs(lx - expected_x_r) < thickness:
                        in_v = True

                if in_v:
                    row.extend([fg_r, fg_g, fg_b, 255])
                else:
                    row.extend([bg_r, bg_g, bg_b, 255])
            else:
                row.extend([0, 0, 0, 0])  # transparente
        pixels.append(bytes(row))

    # Codifica PNG
    def make_png(width, height, rows):
        def chunk(name, data):
            c = name + data
            return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

        # IHDR: width, height, bit depth, color type (6=RGBA), compress, filter, interlace
        ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
        # IDAT: filter byte 0 + raw row data
        raw = b''.join(b'\x00' + row for row in rows)
        idat = zlib.compress(raw)
        return (
            b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', idat)
            + chunk(b'IEND', b'')
        )

    png_data = make_png(width, height, pixels)
    with open(filename, 'wb') as f:
        f.write(png_data)
    print(f'Criado: {filename} ({size}x{size})')


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    for size, name in [(16, 'icon16.png'), (48, 'icon48.png'), (128, 'icon128.png')]:
        create_png_icon(size, name)
    print('Ícones criados com sucesso!')
