#include "radar_model.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DETAIL_LEN 58               // what fits on the status line after a "[WEn] " prefix
#define TEXT_MAX (RADAR_STATUS_LEN - 1)
#define BEGIN_BODY_MIN 19
#define DEFAULT_SCREEN 260          // assumed for size checks while the screen is unknown
#define ON_SCREEN_MARGIN 8          // a plane this far past the edge can still be selected

static uint32_t read_u32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int16_t read_i16(const uint8_t *p) {
  return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

// Puts a watch-side error on the status line. It stays until the phone starts the next view.
static unsigned set_error(RadarModel *m, const char *prefix, const char *detail) {
  m->error = true;
  snprintf(m->status, sizeof(m->status), "%s%s", prefix, detail);
  return RADAR_STATUS | RADAR_STOP_STATUS_TIMER | RADAR_LOG;
}

void radar_model_init(RadarModel *m) {
  memset(m, 0, sizeof(*m));
  m->selected = -1;
  strcpy(m->status, "Starting...");
}

unsigned radar_model_set_screen(RadarModel *m, int16_t width, int16_t height) {
  m->width = width;
  m->height = height;
  m->pixels = malloc((size_t)width * height);
  if (!m->pixels) {
    char detail[DETAIL_LEN];
    snprintf(detail, sizeof(detail), "pixels OOM %dx%d", width, height);
    return set_error(m, "[WE1] ", detail);
  }
  memset(m->pixels, RADAR_PIXEL_BACKGROUND, (size_t)width * height);
  return 0;
}

void radar_model_free_pixels(RadarModel *m) {
  free(m->pixels);
  m->pixels = NULL;
}

void radar_model_free_transfer(RadarModel *m) {
  free(m->rle);
  m->rle = NULL;
  m->rle_received = 0;
  m->rle_size = 0;
}

static unsigned set_status_text(RadarModel *m, const uint8_t *text, uint16_t length) {
  size_t n = length > TEXT_MAX ? TEXT_MAX : length;
  memcpy(m->status, text, n);
  m->status[n] = 0;
  return RADAR_STATUS;
}

static unsigned on_begin(RadarModel *m, const uint8_t *body, uint16_t length) {
  m->error = false;
  if (length < BEGIN_BODY_MIN) {
    char detail[DETAIL_LEN];
    snprintf(detail, sizeof(detail), "BEGIN short %u", (unsigned)length);
    return set_error(m, "[WE2] ", detail);
  }
  m->road_status = body[10];
  m->receiving = true;
  m->plane_count = 0;
  radar_model_free_transfer(m);
  strcpy(m->status, "Receiving...");
  return RADAR_STATUS;
}

static unsigned on_bitmap_begin(RadarModel *m, const uint8_t *body, uint16_t length) {
  char detail[DETAIL_LEN];
  if (length < 4) {
    snprintf(detail, sizeof(detail), "BMBEG short %u", (unsigned)length);
    return set_error(m, "[WE3] ", detail);
  }
  uint32_t size = read_u32(body);
  radar_model_free_transfer(m);
  int w = m->width ? m->width : DEFAULT_SCREEN;
  int h = m->width ? m->height : DEFAULT_SCREEN;
  // Run-length encoding cannot more than double a bitmap.
  if (size == 0 || size > (uint32_t)(w * h + 512) * 2) {
    snprintf(detail, sizeof(detail), "RLE bad sz %u", (unsigned)size);
    return set_error(m, "[WE3] ", detail);
  }
  m->rle = malloc(size);
  if (!m->rle) {
    snprintf(detail, sizeof(detail), "RLE OOM %u", (unsigned)size);
    return set_error(m, "[WE4] ", detail);
  }
  m->rle_size = size;
  m->rle_received = 0;
  return 0;
}

static unsigned on_bitmap_chunk(RadarModel *m, const uint8_t *body, uint16_t length) {
  if (!m->rle) return set_error(m, "[WE5] ", "chunk w/o BEGIN");
  if (m->rle_received + length > m->rle_size) {
    char detail[DETAIL_LEN];
    snprintf(detail, sizeof(detail), "ovf %u+%u>%u", (unsigned)m->rle_received, (unsigned)length, (unsigned)m->rle_size);
    return set_error(m, "[WE5] ", detail);
  }
  memcpy(m->rle + m->rle_received, body, length);
  m->rle_received += length;
  return 0;
}

// Expands (colour, count) pairs into the map, row by row; whatever the pairs do not cover stays background.
static void decode_bitmap(RadarModel *m) {
  int w = m->width, h = m->height;
  int row = 0, col = 0;
  memset(m->pixels, RADAR_PIXEL_BACKGROUND, (size_t)w * h);
  for (uint32_t i = 0; i + 1 < m->rle_received && row < h; i += 2) {
    uint8_t color = m->rle[i];
    int run = m->rle[i + 1];
    while (run > 0 && row < h) {
      int n = run < w - col ? run : w - col;
      memset(m->pixels + row * w + col, color, (size_t)n);
      col += n;
      run -= n;
      if (col >= w) {
        col = 0;
        row++;
      }
    }
  }
}

static const char *road_status_text(uint8_t status) {
  switch (status) {
    case 1: return "[PE1] cached roads";
    case 2: return "[PE2] no major roads";
    case 3: return "[PE3] API cooldown";
    case 4: return "[PE4] fetch timeout";
    case 5: return "[PE5] HTTP error";
    case 6: return "[PE6] no network";
    case 7: return "[PE7] too big (OOM)";
    case 8: return "[PE8] UA blocked";
    default: return "[PE?] unknown";
  }
}

static unsigned on_end(RadarModel *m) {
  unsigned actions = RADAR_REDRAW | RADAR_STATUS;
  bool got_bitmap = m->rle && m->rle_received > 0;
  bool truncated = m->rle && m->rle_received < m->rle_size;
  uint32_t received = m->rle_received, size = m->rle_size;
  if (got_bitmap && m->pixels) decode_bitmap(m);
  radar_model_free_transfer(m);
  m->have_view = true;

  // A full view with good roads must have brought a complete bitmap. (A planes-only refresh has no PAY_BEGIN.)
  if (m->receiving && !m->error && m->road_status == 0) {
    if (!got_bitmap) {
      actions |= set_error(m, "[WE7] ", "no bitmap recvd");
    } else if (truncated) {
      char detail[DETAIL_LEN];
      snprintf(detail, sizeof(detail), "trunc %u/%u", (unsigned)received, (unsigned)size);
      actions |= set_error(m, "[WE8] ", detail);
    }
  }
  m->receiving = false;
  if (!m->pixels) actions |= set_error(m, "[WE1] ", "no pixbuf");

  if (!m->error) {
    if (m->road_status == 0) {
      m->status[0] = 0;
    } else {
      // Shown again after every refresh, for as long as the phone reports the problem.
      snprintf(m->status, sizeof(m->status), "%s", road_status_text(m->road_status));
      actions |= RADAR_STOP_STATUS_TIMER;
    }
  }
  return actions;
}

static void follow_selection(RadarModel *m) {
  if (!m->selection_active) return;
  m->selected = -1;
  for (int i = 0; i < m->plane_count; i++) {
    if (memcmp(m->planes[i].hex, m->selected_hex, 3) == 0) {
      m->selected = i;
      return;
    }
  }
}

static unsigned on_planes(RadarModel *m, const uint8_t *body, uint16_t length) {
  if (length == 0) return RADAR_REDRAW;
  int announced = body[0] > RADAR_MAX_PLANES ? RADAR_MAX_PLANES : body[0];
  int count = 0;
  size_t pos = 1;
  while (count < announced && pos + sizeof(RadarPlane) <= length) {
    RadarPlane *p = &m->planes[count];
    memcpy(p, body + pos, sizeof(RadarPlane));
    int sent = p->trail_n;
    int kept = sent > RADAR_MAX_TRAIL ? RADAR_MAX_TRAIL : sent;
    size_t next = pos + sizeof(RadarPlane) + (size_t)sent * 4;
    if (next > length) break;
    const uint8_t *points = body + pos + sizeof(RadarPlane);
    for (int k = 0; k < kept; k++) {
      m->trails[count][k].x = read_i16(points + k * 4);
      m->trails[count][k].y = read_i16(points + k * 4 + 2);
    }
    p->trail_n = (uint8_t)kept;
    count++;
    pos = next;
  }
  m->plane_count = (uint8_t)count;
  follow_selection(m);
  return RADAR_REDRAW;
}

static unsigned on_trail(RadarModel *m, const uint8_t *body, uint16_t length) {
  if (length < 4) return RADAR_REDRAW;
  for (int i = 0; i < m->plane_count; i++) {
    RadarPlane *p = &m->planes[i];
    if (memcmp(p->hex, body, 3) != 0) continue;
    int sent = body[3];
    int kept = sent > RADAR_MAX_TRAIL ? RADAR_MAX_TRAIL : sent;
    if ((size_t)(kept + 1) * 4 > length) break;
    for (int k = 0; k < kept; k++) {
      m->trails[i][k].x = read_i16(body + 4 + k * 4);
      m->trails[i][k].y = read_i16(body + 4 + k * 4 + 2);
    }
    p->trail_n = (uint8_t)kept;
    if (sent != 0) {
      // The path ends where the plane is now; it is newer than the position in the plane list.
      p->x = m->trails[i][kept - 1].x;
      p->y = m->trails[i][kept - 1].y;
    }
    break;
  }
  return RADAR_REDRAW;
}

unsigned radar_model_receive(RadarModel *m, const uint8_t *data, uint16_t length) {
  if (length == 0) return 0;
  m->phone_seen = true;
  const uint8_t *body = data + 1;
  uint16_t body_length = (uint16_t)(length - 1);
  switch (data[0]) {
    case RADAR_PAY_BEGIN: return on_begin(m, body, body_length);
    case RADAR_PAY_PLANES: return on_planes(m, body, body_length);
    case RADAR_PAY_STATUS:
    case RADAR_PAY_ERROR: return set_status_text(m, body, body_length);
    case RADAR_PAY_END: return on_end(m);
    case RADAR_PAY_BITMAP_BEGIN: return on_bitmap_begin(m, body, body_length);
    case RADAR_PAY_BITMAP_CHUNK: return on_bitmap_chunk(m, body, body_length);
    case RADAR_PAY_TRAIL: return on_trail(m, body, body_length);
    default: return 0;
  }
}

unsigned radar_model_dropped(RadarModel *m, int reason) {
  // Only a drop in the middle of a bitmap loses something that is not sent again.
  if (!m->rle) return 0;
  char detail[DETAIL_LEN];
  snprintf(detail, sizeof(detail), "drop %d @%u/%u", reason, (unsigned)m->rle_received, (unsigned)m->rle_size);
  return set_error(m, "[WE6] ", detail);
}

static bool on_screen(const RadarModel *m, const RadarPlane *p, bool round) {
  if (m->width == 0) return true;
  int x = p->x, y = p->y;
  if (round) {
    int r = (m->width < m->height ? m->width : m->height) / 2 + ON_SCREEN_MARGIN;
    return x * x + y * y <= r * r;
  }
  return abs(x) <= m->width / 2 + ON_SCREEN_MARGIN && abs(y) <= m->height / 2 + ON_SCREEN_MARGIN;
}

RadarStep radar_model_step(RadarModel *m, int dir, bool round) {
  if (m->plane_count == 0) return RADAR_STEP_NONE;
  int order[RADAR_MAX_PLANES];
  int dist[RADAR_MAX_PLANES];
  int n = 0;
  for (int i = 0; i < m->plane_count; i++) {
    const RadarPlane *p = &m->planes[i];
    if (!on_screen(m, p, round)) continue;
    // insertion sort by distance from the centre; planes equally far keep their order in the list
    int d = p->x * p->x + p->y * p->y;
    int at = n;
    while (at > 0 && dist[at - 1] > d) {
      dist[at] = dist[at - 1];
      order[at] = order[at - 1];
      at--;
    }
    dist[at] = d;
    order[at] = i;
    n++;
  }
  if (n == 0) {
    strcpy(m->status, "No traffic in view");
    return RADAR_STEP_NO_TRAFFIC;
  }
  int pick = dir == 1 ? 0 : n - 1;
  for (int k = 0; k < n; k++) {
    if (order[k] == m->selected) {
      pick = (k + dir + n) % n;
      break;
    }
  }
  m->selected = order[pick];
  memcpy(m->selected_hex, m->planes[m->selected].hex, 3);
  m->selection_active = true;
  return RADAR_STEP_SELECTED;
}

void radar_model_deselect(RadarModel *m) {
  m->selected = -1;
  m->selection_active = false;
}

void radar_format_altitude(int16_t alt100, char *out, size_t size) {
  int feet = alt100 * 100;
  if (feet < 1) {
    snprintf(out, size, "GND");
  } else if (feet < 1000) {
    snprintf(out, size, "%d ft", feet);
  } else {
    snprintf(out, size, "%d,%03d ft", feet / 1000, feet % 1000);
  }
}
