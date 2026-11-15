// Pure-C state of the watch app: the messages from the phone, the map bitmap, the aircraft list and the
// selection (no pebble.h; host-tested, CONTRACTS.md §7). Mirrors src/common/protocol.js: keep the two in step.
#pragma once
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define RADAR_MAX_PLANES 32
#define RADAR_MAX_TRAIL 16
#define RADAR_STATUS_LEN 64

// First byte of a PAYLOAD from the phone.
enum {
  RADAR_PAY_BEGIN = 0x01,         // lat, lon (i32 1e-6 deg), visible miles u16, road status u16, plane count u16, geohash[5]
  RADAR_PAY_PLANES = 0x03,        // count, then per plane a RadarPlane record and its trail points
  RADAR_PAY_STATUS = 0x04,        // text for the status line
  RADAR_PAY_ERROR = 0x05,         // text for the status line
  RADAR_PAY_END = 0x06,           // the view is complete: decode the bitmap and show it
  RADAR_PAY_BITMAP_BEGIN = 0x07,  // u32 size of the run-length encoded bitmap
  RADAR_PAY_BITMAP_CHUNK = 0x08,  // the next bytes of it
  RADAR_PAY_TRAIL = 0x09,         // hex[3], count, points: the flight path of one plane
};

// Watch -> phone.
enum { RADAR_CMD_HELLO = 1, RADAR_CMD_REFRESH_PLANES = 2, RADAR_CMD_VIEW = 4 };
#define RADAR_SUBCMD_SELECT 0x80

// GColor8 value of an empty map pixel (black).
#define RADAR_PIXEL_BACKGROUND 0xC0

typedef struct {
  int16_t x, y;
} RadarPoint;

// One aircraft exactly as it is on the wire. x, y are pixels from the centre of the screen.
typedef struct __attribute__((packed)) {
  uint8_t hex[3];     // ICAO address
  int16_t x, y;
  uint8_t alt_class;  // 0 below 12,000 ft, 1 up to 28,000 ft, 2 above
  uint8_t track;      // heading, 256 steps per turn, 0 = north
  char callsign[8];   // NUL-padded, not terminated when full
  char tail[8];
  char type[6];
  int16_t alt100;     // hundreds of feet, 0 on the ground
  uint16_t gs;        // knots
  uint8_t trail_n;    // trail points that follow the record (at most RADAR_MAX_TRAIL are kept)
} RadarPlane;

typedef struct {
  RadarPlane planes[RADAR_MAX_PLANES];
  RadarPoint trails[RADAR_MAX_PLANES][RADAR_MAX_TRAIL];  // oldest first, pixels from the centre
  uint8_t plane_count;

  int selected;           // index into planes, -1 = none
  bool selection_active;  // a plane was picked; `selected` follows its address across refreshes
  uint8_t selected_hex[3];

  int16_t width, height;  // screen size, 0 until radar_model_set_screen
  uint8_t *pixels;        // width * height GColor8 bytes, NULL when it could not be allocated
  uint8_t *rle;           // the bitmap being received
  uint32_t rle_received, rle_size;

  bool phone_seen;        // any message arrived: stop saying hello
  bool receiving;         // between PAY_BEGIN and PAY_END
  bool have_view;         // a view was completed: draw the map and the planes
  bool error;             // a watch-side error is on the status line; kept until the next PAY_BEGIN
  uint8_t road_status;    // from PAY_BEGIN, 0 = roads are fine

  char status[RADAR_STATUS_LEN];  // the status line, "" = hidden
} RadarModel;

// What the caller has to do after a model call (bit set).
enum {
  RADAR_REDRAW = 1,             // the map or the planes changed
  RADAR_STATUS = 2,             // `status` changed: show it, or hide the line when it is empty
  RADAR_STOP_STATUS_TIMER = 4,  // the status line must stay: cancel the timer that would hide it
  RADAR_LOG = 8,                // an error was put on the status line (worth logging)
};

typedef enum { RADAR_STEP_NONE, RADAR_STEP_SELECTED, RADAR_STEP_NO_TRAFFIC } RadarStep;

void radar_model_init(RadarModel *m);

// Allocates the map for a width x height screen. Returns the actions to take (an error when out of memory).
unsigned radar_model_set_screen(RadarModel *m, int16_t width, int16_t height);

void radar_model_free_pixels(RadarModel *m);
void radar_model_free_transfer(RadarModel *m);

// One PAYLOAD byte array from the phone. Returns the actions to take.
unsigned radar_model_receive(RadarModel *m, const uint8_t *data, uint16_t length);

// The system dropped an incoming message. Returns the actions to take.
unsigned radar_model_dropped(RadarModel *m, int reason);

// Moves the selection to the next (dir 1) or previous (dir -1) plane on screen, ordered by distance from the
// centre and wrapping around; with nothing selected, 1 picks the closest and -1 the farthest. `round` selects the
// test for "on screen". RADAR_STEP_NO_TRAFFIC also puts a note on the status line.
RadarStep radar_model_step(RadarModel *m, int dir, bool round);

void radar_model_deselect(RadarModel *m);

// Altitude as shown for the selected plane: "GND", "850 ft", "12,300 ft".
void radar_format_altitude(int16_t alt100, char *out, size_t size);
