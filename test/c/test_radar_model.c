// Host-side tests for src/c/radar_model.c: the messages from the phone, the map bitmap and the selection
// (CONTRACTS.md §7).
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "radar_model.h"

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(got, want) do { checks++; long g_ = (long)(got), w_ = (long)(want); if (g_ != w_) { failures++; \
  printf("FAIL %s:%d: %s = %ld, want %ld\n", __FILE__, __LINE__, #got, g_, w_); } } while (0)
#define CHECK_STR(got, want) do { checks++; if (strcmp((got), (want)) != 0) { failures++; \
  printf("FAIL %s:%d: %s = \"%s\", want \"%s\"\n", __FILE__, __LINE__, #got, (got), (want)); } } while (0)

#define SHOWN (RADAR_STATUS | RADAR_STOP_STATUS_TIMER | RADAR_LOG)  // an error was put on the status line

static RadarModel m;

static void start(int w, int h) {
  radar_model_free_pixels(&m);
  radar_model_free_transfer(&m);
  radar_model_init(&m);
  if (w) CHECK_EQ(radar_model_set_screen(&m, (int16_t)w, (int16_t)h), 0);
}

static unsigned receive(const uint8_t *data, size_t length) {
  return radar_model_receive(&m, data, (uint16_t)length);
}

static unsigned begin(uint8_t road_status) {
  uint8_t msg[20] = {RADAR_PAY_BEGIN};
  msg[11] = road_status;
  return receive(msg, sizeof(msg));
}

static unsigned end(void) {
  uint8_t msg[] = {RADAR_PAY_END};
  return receive(msg, sizeof(msg));
}

static unsigned bitmap_begin(uint32_t size) {
  uint8_t msg[] = {RADAR_PAY_BITMAP_BEGIN, (uint8_t)size, (uint8_t)(size >> 8), (uint8_t)(size >> 16), (uint8_t)(size >> 24)};
  return receive(msg, sizeof(msg));
}

static unsigned chunk(const uint8_t *bytes, size_t n) {
  uint8_t msg[1 + 64];
  msg[0] = RADAR_PAY_BITMAP_CHUNK;
  memcpy(msg + 1, bytes, n);
  return receive(msg, 1 + n);
}

// A PAY_PLANES message under construction.
static uint8_t planes_msg[4096];
static size_t planes_len;

static void planes_start(int announced) {
  planes_msg[0] = RADAR_PAY_PLANES;
  planes_msg[1] = (uint8_t)announced;
  planes_len = 2;
}

static void planes_add(const char *hex3, int x, int y, int trail_n) {
  RadarPlane p;
  memset(&p, 0, sizeof(p));
  memcpy(p.hex, hex3, 3);
  p.x = (int16_t)x;
  p.y = (int16_t)y;
  p.alt_class = 1;
  p.track = 64;
  memcpy(p.callsign, "DAL2446", 7);
  p.alt100 = 123;
  p.gs = 305;
  p.trail_n = (uint8_t)trail_n;
  memcpy(planes_msg + planes_len, &p, sizeof(p));
  planes_len += sizeof(p);
  for (int k = 0; k < trail_n; k++) {
    int16_t tx = (int16_t)(x - (trail_n - k)), ty = (int16_t)(y + k);
    memcpy(planes_msg + planes_len, &tx, 2);
    memcpy(planes_msg + planes_len + 2, &ty, 2);
    planes_len += 4;
  }
}

static unsigned planes_send(void) { return receive(planes_msg, planes_len); }

static void test_wire_record(void) {
  CHECK_EQ(sizeof(RadarPlane), 36);
  CHECK_EQ(offsetof(RadarPlane, x), 3);
  CHECK_EQ(offsetof(RadarPlane, callsign), 9);
  CHECK_EQ(offsetof(RadarPlane, alt100), 31);
  CHECK_EQ(offsetof(RadarPlane, trail_n), 35);
}

static void test_init(void) {
  start(0, 0);
  CHECK_STR(m.status, "Starting...");
  CHECK_EQ(m.selected, -1);
  CHECK(!m.phone_seen && !m.have_view && !m.error && !m.pixels);
  CHECK_EQ(receive(NULL, 0), 0);
  CHECK(!m.phone_seen);
  start(6, 4);
  CHECK(m.pixels != NULL);
  for (int i = 0; i < 24; i++) CHECK_EQ(m.pixels[i], RADAR_PIXEL_BACKGROUND);
}

static void test_status_texts(void) {
  start(6, 4);
  uint8_t status[] = {RADAR_PAY_STATUS, 'F', 'e', 't', 'c', 'h'};
  CHECK_EQ(receive(status, sizeof(status)), RADAR_STATUS);
  CHECK_STR(m.status, "Fetch");
  CHECK(m.phone_seen);
  uint8_t error[] = {RADAR_PAY_ERROR, 'G', 'P', 'S'};
  CHECK_EQ(receive(error, sizeof(error)), RADAR_STATUS);
  CHECK_STR(m.status, "GPS");
  CHECK(!m.error);  // the phone's errors are replaced by its next status
  uint8_t empty[] = {RADAR_PAY_STATUS};
  CHECK_EQ(receive(empty, sizeof(empty)), RADAR_STATUS);
  CHECK_STR(m.status, "");
  uint8_t longer[1 + 80];
  memset(longer, 'x', sizeof(longer));
  longer[0] = RADAR_PAY_STATUS;
  receive(longer, sizeof(longer));
  CHECK_EQ(strlen(m.status), 63);
  uint8_t unknown[] = {0x42, 1, 2, 3};
  CHECK_EQ(receive(unknown, sizeof(unknown)), 0);
}

static void test_begin(void) {
  start(6, 4);
  planes_start(1);
  planes_add("\xaa\xbb\xcc", 1, 2, 0);
  planes_send();
  CHECK_EQ(m.plane_count, 1);
  CHECK_EQ(begin(4), RADAR_STATUS);
  CHECK_STR(m.status, "Receiving...");
  CHECK(m.receiving);
  CHECK_EQ(m.road_status, 4);
  CHECK_EQ(m.plane_count, 0);
  uint8_t shorter[19] = {RADAR_PAY_BEGIN};
  CHECK_EQ(receive(shorter, sizeof(shorter)), SHOWN);
  CHECK_STR(m.status, "[WE2] BEGIN short 18");
  CHECK(m.error);
  CHECK_EQ(begin(0), RADAR_STATUS);  // the next view clears the error
  CHECK(!m.error);
}

static void test_bitmap(void) {
  start(6, 4);
  // 24 pixels: 5 of colour 1, 13 of colour 2 (wrapping over three rows), 6 of colour 3
  const uint8_t rle[] = {1, 5, 2, 13, 3, 6};
  CHECK_EQ(begin(0), RADAR_STATUS);
  CHECK_EQ(bitmap_begin(sizeof(rle)), 0);
  CHECK_EQ(chunk(rle, 4), 0);
  CHECK_EQ(chunk(rle + 4, 2), 0);
  CHECK_EQ(m.rle_received, 6);
  CHECK(!m.have_view);
  CHECK_EQ(end(), RADAR_REDRAW | RADAR_STATUS);
  const uint8_t want[24] = {1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3};
  CHECK(memcmp(m.pixels, want, 24) == 0);
  CHECK(m.have_view && !m.receiving && !m.error);
  CHECK(m.rle == NULL);
  CHECK_STR(m.status, "");  // good roads: the status line goes away
}

static void test_bitmap_edges(void) {
  // runs past the end of the bitmap are cut; a short encoding leaves background behind
  start(6, 4);
  const uint8_t over[] = {7, 255};
  begin(0); bitmap_begin(2); chunk(over, 2);
  CHECK_EQ(end(), RADAR_REDRAW | RADAR_STATUS);
  for (int i = 0; i < 24; i++) CHECK_EQ(m.pixels[i], 7);
  const uint8_t under[] = {9, 4};
  begin(0); bitmap_begin(2); chunk(under, 2);
  end();
  CHECK_EQ(m.pixels[3], 9);
  CHECK_EQ(m.pixels[4], RADAR_PIXEL_BACKGROUND);
  CHECK_EQ(m.pixels[23], RADAR_PIXEL_BACKGROUND);
  // an odd byte at the end is ignored; a zero run paints nothing
  const uint8_t odd[] = {5, 2, 6, 0, 8, 1, 4};
  begin(0); bitmap_begin(7); chunk(odd, 7);
  end();
  CHECK_EQ(m.pixels[0], 5); CHECK_EQ(m.pixels[1], 5); CHECK_EQ(m.pixels[2], 8); CHECK_EQ(m.pixels[3], RADAR_PIXEL_BACKGROUND);
}

static void test_bitmap_errors(void) {
  start(6, 4);
  const uint8_t rle[] = {1, 5, 2, 13, 3, 6};
  // size checks: 0 and anything a 6 x 4 bitmap cannot need
  begin(0);
  CHECK_EQ(bitmap_begin(0), SHOWN);
  CHECK_STR(m.status, "[WE3] RLE bad sz 0");
  begin(0);
  CHECK_EQ(bitmap_begin((6 * 4 + 512) * 2), 0);
  CHECK_EQ(bitmap_begin((6 * 4 + 512) * 2 + 1), SHOWN);
  CHECK_STR(m.status, "[WE3] RLE bad sz 1073");
  uint8_t tiny[] = {RADAR_PAY_BITMAP_BEGIN, 1, 0, 0};
  begin(0);
  CHECK_EQ(receive(tiny, sizeof(tiny)), SHOWN);
  CHECK_STR(m.status, "[WE3] BMBEG short 3");
  // a chunk with no bitmap begun
  start(6, 4);
  CHECK_EQ(chunk(rle, 2), SHOWN);
  CHECK_STR(m.status, "[WE5] chunk w/o BEGIN");
  // more bytes than announced
  begin(0); bitmap_begin(4); chunk(rle, 3);
  CHECK_EQ(chunk(rle, 2), SHOWN);
  CHECK_STR(m.status, "[WE5] ovf 3+2>4");
  CHECK_EQ(m.rle_received, 3);
  // fewer bytes than announced: what arrived is shown, and the error
  begin(0); bitmap_begin(6); chunk(rle, 4);
  CHECK_EQ(end(), RADAR_REDRAW | SHOWN);
  CHECK_STR(m.status, "[WE8] trunc 4/6");
  CHECK_EQ(m.pixels[0], 1); CHECK_EQ(m.pixels[17], 2); CHECK_EQ(m.pixels[18], RADAR_PIXEL_BACKGROUND);
  // a view without any bitmap
  begin(0);
  CHECK_EQ(end(), RADAR_REDRAW | SHOWN);
  CHECK_STR(m.status, "[WE7] no bitmap recvd");
  begin(0); bitmap_begin(6);
  CHECK_EQ(end(), RADAR_REDRAW | SHOWN);
  CHECK_STR(m.status, "[WE7] no bitmap recvd");
  // the error survives a planes-only refresh, until the next view begins
  CHECK_EQ(end(), RADAR_REDRAW | RADAR_STATUS);
  CHECK_STR(m.status, "[WE7] no bitmap recvd");
  CHECK(m.error);
}

static void test_dropped_message(void) {
  start(6, 4);
  CHECK_EQ(radar_model_dropped(&m, 2), 0);  // nothing in flight: the next refresh repairs it
  CHECK_STR(m.status, "Starting...");
  const uint8_t rle[] = {1, 5};
  begin(0); bitmap_begin(6); chunk(rle, 2);
  CHECK_EQ(radar_model_dropped(&m, 8), SHOWN);
  CHECK_STR(m.status, "[WE6] drop 8 @2/6");
}

static void test_road_status(void) {
  static const char *const want[] = {
    "", "[PE1] cached roads", "[PE2] no major roads", "[PE3] API cooldown", "[PE4] fetch timeout",
    "[PE5] HTTP error", "[PE6] no network", "[PE7] too big (OOM)", "[PE8] UA blocked", "[PE?] unknown",
  };
  const uint8_t rle[] = {1, 24};
  for (int status = 0; status <= 9; status++) {
    start(6, 4);
    begin((uint8_t)status); bitmap_begin(2); chunk(rle, 2);
    CHECK_EQ(end(), RADAR_REDRAW | RADAR_STATUS | (status ? RADAR_STOP_STATUS_TIMER : 0));
    CHECK_STR(m.status, want[status]);
    CHECK(!m.error);
    CHECK_EQ(m.pixels[0], 1);  // the bitmap is shown whatever the status
  }
  // roads the phone could not get need no bitmap, and the reason comes back after every refresh
  start(6, 4);
  begin(4);
  CHECK_EQ(end(), RADAR_REDRAW | RADAR_STATUS | RADAR_STOP_STATUS_TIMER);
  CHECK_STR(m.status, "[PE4] fetch timeout");
  uint8_t note[] = {RADAR_PAY_STATUS, 'x'};
  receive(note, sizeof(note));
  CHECK_EQ(end(), RADAR_REDRAW | RADAR_STATUS | RADAR_STOP_STATUS_TIMER);
  CHECK_STR(m.status, "[PE4] fetch timeout");
}

static void test_no_pixels(void) {
  start(0, 0);  // the screen was never set up (or its bitmap could not be allocated)
  const uint8_t rle[] = {1, 24};
  begin(0); bitmap_begin(2); chunk(rle, 2);
  CHECK_EQ(end(), RADAR_REDRAW | SHOWN);
  CHECK_STR(m.status, "[WE1] no pixbuf");
}

static void test_planes(void) {
  start(200, 228);
  planes_start(3);
  planes_add("\xac\x9a\xbc", 12, -14, 0);
  planes_add("\xa0\x57\xc7", 22, -10, 3);
  planes_add("\xab\x8c\xa5", -300, 400, 0);
  CHECK_EQ(planes_send(), RADAR_REDRAW);
  CHECK_EQ(m.plane_count, 3);
  CHECK_EQ(m.planes[0].x, 12); CHECK_EQ(m.planes[0].y, -14);
  CHECK_EQ(m.planes[0].alt_class, 1); CHECK_EQ(m.planes[0].track, 64);
  CHECK(memcmp(m.planes[0].callsign, "DAL2446\0", 8) == 0);
  CHECK_EQ(m.planes[0].alt100, 123); CHECK_EQ(m.planes[0].gs, 305);
  CHECK_EQ(m.planes[1].trail_n, 3);
  CHECK_EQ(m.trails[1][0].x, 19); CHECK_EQ(m.trails[1][0].y, -10);
  CHECK_EQ(m.trails[1][2].x, 21); CHECK_EQ(m.trails[1][2].y, -8);
  CHECK_EQ(m.planes[2].x, -300); CHECK_EQ(m.planes[2].y, 400);
  // the next list replaces it
  planes_start(1);
  planes_add("\x01\x02\x03", 5, 5, 0);
  planes_send();
  CHECK_EQ(m.plane_count, 1);
  planes_start(0);
  CHECK_EQ(planes_send(), RADAR_REDRAW);
  CHECK_EQ(m.plane_count, 0);
}

static void test_planes_limits(void) {
  start(200, 228);
  // 40 announced and sent: the first 32 are kept
  planes_start(40);
  for (int i = 0; i < 40; i++) { char hex[3] = {1, 2, (char)i}; planes_add(hex, i, 0, 0); }
  planes_send();
  CHECK_EQ(m.plane_count, RADAR_MAX_PLANES);
  CHECK_EQ(m.planes[31].x, 31);
  // a trail longer than 16 points: 16 kept, and the plane after it is still found
  planes_start(2);
  planes_add("\x01\x02\x03", 50, 50, 20);
  planes_add("\x04\x05\x06", 7, 8, 0);
  planes_send();
  CHECK_EQ(m.plane_count, 2);
  CHECK_EQ(m.planes[0].trail_n, RADAR_MAX_TRAIL);
  CHECK_EQ(m.trails[0][15].x, 50 - 20 + 15);
  CHECK_EQ(m.planes[1].x, 7);
  // fewer records than announced, and a record cut short, end the list where the data ends
  planes_start(5);
  planes_add("\x01\x02\x03", 1, 1, 0);
  planes_add("\x04\x05\x06", 2, 2, 0);
  planes_send();
  CHECK_EQ(m.plane_count, 2);
  planes_len -= 10;
  planes_send();
  CHECK_EQ(m.plane_count, 1);
  planes_start(1);
  planes_add("\x01\x02\x03", 1, 1, 4);
  planes_len -= 1;  // the last trail point is incomplete
  planes_send();
  CHECK_EQ(m.plane_count, 0);
}

static unsigned trail(const char *hex3, int announced, int sent, int x0) {
  uint8_t msg[5 + 4 * 32] = {RADAR_PAY_TRAIL, (uint8_t)hex3[0], (uint8_t)hex3[1], (uint8_t)hex3[2], (uint8_t)announced};
  for (int k = 0; k < sent; k++) {
    int16_t x = (int16_t)(x0 + k), y = (int16_t)(-k);
    memcpy(msg + 5 + k * 4, &x, 2);
    memcpy(msg + 5 + k * 4 + 2, &y, 2);
  }
  return receive(msg, 5 + (size_t)sent * 4);
}

static void test_trail(void) {
  start(200, 228);
  planes_start(2);
  planes_add("\xac\x9a\xbc", 12, -14, 0);
  planes_add("\xa0\x57\xc7", 22, -10, 0);
  planes_send();
  CHECK_EQ(trail("\xa0\x57\xc7", 3, 3, 40), RADAR_REDRAW);
  CHECK_EQ(m.planes[1].trail_n, 3);
  CHECK_EQ(m.trails[1][0].x, 40); CHECK_EQ(m.trails[1][2].x, 42); CHECK_EQ(m.trails[1][2].y, -2);
  // the plane moves to the end of its path
  CHECK_EQ(m.planes[1].x, 42); CHECK_EQ(m.planes[1].y, -2);
  CHECK_EQ(m.planes[0].x, 12); CHECK_EQ(m.planes[0].trail_n, 0);
  // an empty path clears the trail and leaves the plane where it is
  CHECK_EQ(trail("\xa0\x57\xc7", 0, 0, 0), RADAR_REDRAW);
  CHECK_EQ(m.planes[1].trail_n, 0);
  CHECK_EQ(m.planes[1].x, 42);
  // 20 points: 16 kept, the plane at the 16th
  trail("\xac\x9a\xbc", 20, 20, 100);
  CHECK_EQ(m.planes[0].trail_n, 16);
  CHECK_EQ(m.planes[0].x, 115);
  // unknown plane, or fewer points than announced: nothing changes
  trail("\x00\x00\x01", 2, 2, 7);
  trail("\xa0\x57\xc7", 3, 2, 70);
  CHECK_EQ(m.planes[1].trail_n, 0); CHECK_EQ(m.planes[1].x, 42);
  uint8_t tiny[] = {RADAR_PAY_TRAIL, 0xa0, 0x57, 0xc7};
  CHECK_EQ(receive(tiny, sizeof(tiny)), RADAR_REDRAW);
}

// Five planes for the selection tests, in list order; distances from the centre: 5, 50, 30, 109.2, 50.
static void step_planes(void) {
  planes_start(5);
  planes_add("\x00\x00\x01", 3, 4, 0);
  planes_add("\x00\x00\x02", 30, -40, 0);
  planes_add("\x00\x00\x03", 0, 30, 0);
  planes_add("\x00\x00\x04", 105, -30, 0);   // 5 px past the right edge of the 200 px wide screen
  planes_add("\x00\x00\x05", -50, 0, 0);
  planes_send();
}

static void test_step(void) {
  start(200, 228);
  CHECK_EQ(radar_model_step(&m, 1, false), RADAR_STEP_NONE);  // no planes at all: nothing to say
  CHECK_STR(m.status, "Starting...");
  step_planes();
  // up: closest first, then outwards; equally distant planes in list order; wraps around
  static const int order[] = {0, 2, 1, 4, 3, 0};
  for (int i = 0; i < 6; i++) {
    CHECK_EQ(radar_model_step(&m, 1, false), RADAR_STEP_SELECTED);
    CHECK_EQ(m.selected, order[i]);
    CHECK(m.selection_active);
    CHECK_EQ(m.selected_hex[2], order[i] + 1);
  }
  // down goes back, past the closest to the farthest
  CHECK_EQ(radar_model_step(&m, -1, false), RADAR_STEP_SELECTED);
  CHECK_EQ(m.selected, 3);
  CHECK_EQ(radar_model_step(&m, -1, false), RADAR_STEP_SELECTED);
  CHECK_EQ(m.selected, 4);
  // with nothing selected, down starts at the farthest
  radar_model_deselect(&m);
  CHECK_EQ(m.selected, -1);
  CHECK(!m.selection_active);
  CHECK_EQ(radar_model_step(&m, -1, false), RADAR_STEP_SELECTED);
  CHECK_EQ(m.selected, 3);
}

static void test_step_on_screen(void) {
  // rectangular: up to 8 px past each edge counts as on screen
  start(200, 228);
  planes_start(4);
  planes_add("\x00\x00\x01", 108, 0, 0);
  planes_add("\x00\x00\x02", 109, 0, 0);
  planes_add("\x00\x00\x03", 0, -122, 0);
  planes_add("\x00\x00\x04", 0, 123, 0);
  planes_send();
  CHECK_EQ(radar_model_step(&m, 1, false), RADAR_STEP_SELECTED);
  CHECK_EQ(m.selected, 0);
  CHECK_EQ(radar_model_step(&m, 1, false), RADAR_STEP_SELECTED);
  CHECK_EQ(m.selected, 2);
  CHECK_EQ(radar_model_step(&m, 1, false), RADAR_STEP_SELECTED);
  CHECK_EQ(m.selected, 0);
  // round: within the radius plus 8 px
  start(260, 260);
  planes_start(3);
  planes_add("\x00\x00\x01", 97, 97, 0);    // 137.2 px out
  planes_add("\x00\x00\x02", 98, 98, 0);    // 138.6 px
  planes_add("\x00\x00\x03", 0, -138, 0);
  planes_send();
  CHECK_EQ(radar_model_step(&m, -1, true), RADAR_STEP_SELECTED);
  CHECK_EQ(m.selected, 2);
  CHECK_EQ(radar_model_step(&m, -1, true), RADAR_STEP_SELECTED);
  CHECK_EQ(m.selected, 0);
  CHECK_EQ(radar_model_step(&m, -1, true), RADAR_STEP_SELECTED);
  CHECK_EQ(m.selected, 2);
  // the corner plane is on the rectangular screen of that size
  radar_model_deselect(&m);
  CHECK_EQ(radar_model_step(&m, -1, false), RADAR_STEP_SELECTED);
  CHECK_EQ(m.selected, 1);
}

static void test_step_no_traffic(void) {
  start(200, 228);
  planes_start(1);
  planes_add("\x00\x00\x01", 150, 0, 0);
  planes_send();
  CHECK_EQ(radar_model_step(&m, 1, false), RADAR_STEP_NO_TRAFFIC);
  CHECK_STR(m.status, "No traffic in view");
  CHECK_EQ(m.selected, -1);
  CHECK(!m.selection_active);
}

static void test_selection_follows_the_plane(void) {
  start(200, 228);
  step_planes();
  radar_model_step(&m, 1, false);
  radar_model_step(&m, 1, false);
  CHECK_EQ(m.selected, 2);
  // the next list has the plane somewhere else
  planes_start(3);
  planes_add("\x00\x00\x09", 1, 1, 0);
  planes_add("\x00\x00\x08", 2, 2, 0);
  planes_add("\x00\x00\x03", 60, 60, 0);
  planes_send();
  CHECK_EQ(m.selected, 2);
  planes_start(2);
  planes_add("\x00\x00\x03", 60, 60, 0);
  planes_add("\x00\x00\x09", 1, 1, 0);
  planes_send();
  CHECK_EQ(m.selected, 0);
  // gone from the list: nothing is highlighted, but it is picked up again when it returns
  planes_start(1);
  planes_add("\x00\x00\x09", 1, 1, 0);
  planes_send();
  CHECK_EQ(m.selected, -1);
  CHECK(m.selection_active);
  planes_start(2);
  planes_add("\x00\x00\x09", 1, 1, 0);
  planes_add("\x00\x00\x03", 60, 60, 0);
  planes_send();
  CHECK_EQ(m.selected, 1);
  // after BACK it is not
  radar_model_deselect(&m);
  planes_send();
  CHECK_EQ(m.selected, -1);
  // a new view keeps the selection through its empty moment
  radar_model_step(&m, 1, false);
  int picked = m.selected;
  begin(0);
  CHECK_EQ(m.plane_count, 0);
  planes_send();
  CHECK_EQ(m.selected, picked);
}

static void test_altitude(void) {
  char text[16];
  radar_format_altitude(0, text, sizeof(text)); CHECK_STR(text, "GND");
  radar_format_altitude(-3, text, sizeof(text)); CHECK_STR(text, "GND");
  radar_format_altitude(1, text, sizeof(text)); CHECK_STR(text, "100 ft");
  radar_format_altitude(9, text, sizeof(text)); CHECK_STR(text, "900 ft");
  radar_format_altitude(10, text, sizeof(text)); CHECK_STR(text, "1,000 ft");
  radar_format_altitude(123, text, sizeof(text)); CHECK_STR(text, "12,300 ft");
  radar_format_altitude(410, text, sizeof(text)); CHECK_STR(text, "41,000 ft");
  radar_format_altitude(32767, text, sizeof(text)); CHECK_STR(text, "3276,700 ft");
}

int main(void) {
  radar_model_init(&m);
  test_wire_record();
  test_init();
  test_status_texts();
  test_begin();
  test_bitmap();
  test_bitmap_edges();
  test_bitmap_errors();
  test_dropped_message();
  test_road_status();
  test_no_pixels();
  test_planes();
  test_planes_limits();
  test_trail();
  test_step();
  test_step_on_screen();
  test_step_no_traffic();
  test_selection_follows_the_plane();
  test_altitude();
  radar_model_free_pixels(&m);
  radar_model_free_transfer(&m);
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
