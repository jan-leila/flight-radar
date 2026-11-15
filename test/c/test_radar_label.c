// Host-side tests for src/c/radar_label.c: where the text box of an aircraft goes (CONTRACTS.md §8).
#include <stdio.h>
#include <stdlib.h>
#include "radar_label.h"

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { failures++; printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(got, want) do { checks++; long g_ = (long)(got), w_ = (long)(want); if (g_ != w_) { failures++; \
  printf("FAIL %s:%d: %s = %ld, want %ld\n", __FILE__, __LINE__, #got, g_, w_); } } while (0)
#define CHECK_AT(p, wx, wy) do { RadarPoint p_ = (p); CHECK_EQ(p_.x, wx); CHECK_EQ(p_.y, wy); } while (0)

static const RadarScreen RECT = {200, 228, false};
static const RadarScreen ROUND = {260, 260, true};
static const RadarPoint ORIGIN = {100, 114};

static RadarPoint place(RadarPoint at, int w, int h, RadarScreen screen) {
  return radar_label_place(at, w, h, screen, ORIGIN, NULL, 0);
}

static void test_first_choice(void) {
  // room everywhere: right of the aircraft, 8 px up
  CHECK_AT(place((RadarPoint){100, 100}, 50, 18, RECT), 110, 92);
  CHECK_AT(place((RadarPoint){130, 130}, 50, 18, ROUND), 140, 122);
}

static void test_candidates_in_order(void) {
  // too close to the top for 8 px up: right and 6 px down
  CHECK_AT(place((RadarPoint){100, 9}, 50, 18, RECT), 110, 15);
  // too close to the right edge: the box ends 10 px left of the aircraft
  CHECK_AT(place((RadarPoint){160, 100}, 50, 18, RECT), 100, 92);
  // right edge and top: left and down
  CHECK_AT(place((RadarPoint){160, 9}, 50, 18, RECT), 100, 15);
  // a box too wide for either side is centred above the aircraft
  CHECK_AT(place((RadarPoint){100, 100}, 120, 18, RECT), 40, 72);
  // ... or below it when there is no room above
  CHECK_AT(place((RadarPoint){100, 20}, 120, 18, RECT), 40, 36);
}

static void test_edges_are_exact(void) {
  // a box may start at x = 2 and must end before width - 1
  CHECK_AT(place((RadarPoint){62, 100}, 50, 18, RECT), 72, 92);      // plenty of room
  CHECK_AT(place((RadarPoint){138, 100}, 50, 18, RECT), 148, 92);    // 148 + 50 = 198 < 199
  CHECK_AT(place((RadarPoint){139, 100}, 50, 18, RECT), 79, 92);     // 149 + 50 = 199: no longer fits on the right
  CHECK_AT(place((RadarPoint){100, 10}, 50, 18, RECT), 110, 2);      // y = 2 is allowed
  CHECK_AT(place((RadarPoint){100, 216}, 50, 18, RECT), 110, 208);   // 208 + 18 = 226 < 227: the last row that fits
  CHECK_AT(place((RadarPoint){100, 217}, 50, 18, RECT), 75, 189);    // then the next place with room: centred above
}

static void test_fallback(void) {
  // nothing fits a box as wide as the screen: up and to the right, pushed back on screen
  CHECK_AT(place((RadarPoint){100, 100}, 198, 18, RECT), 2, 92);
  CHECK_AT(place((RadarPoint){100, 5}, 198, 18, RECT), 2, 2);
  CHECK_AT(place((RadarPoint){100, 226}, 198, 18, RECT), 2, 208);
  // a tall box: no candidate has room
  CHECK_AT(place((RadarPoint){190, 100}, 60, 226, RECT), 138, 2);
}

static void test_segment_hits(void) {
  RadarBox box = {50, 50, 40, 20};
  CHECK(radar_label_segment_hits((RadarPoint){60, 60}, (RadarPoint){200, 200}, box));    // starts inside
  CHECK(radar_label_segment_hits((RadarPoint){0, 0}, (RadarPoint){89, 69}, box));        // ends in the last pixel
  CHECK(!radar_label_segment_hits((RadarPoint){95, 0}, (RadarPoint){90, 70}, box));      // along its right edge, one pixel out
  CHECK(radar_label_segment_hits((RadarPoint){0, 60}, (RadarPoint){200, 60}, box));      // passes through
  CHECK(radar_label_segment_hits((RadarPoint){70, 0}, (RadarPoint){70, 200}, box));
  CHECK(!radar_label_segment_hits((RadarPoint){0, 0}, (RadarPoint){49, 200}, box));      // left of it
  CHECK(!radar_label_segment_hits((RadarPoint){0, 71}, (RadarPoint){200, 71}, box));     // below it
  CHECK(!radar_label_segment_hits((RadarPoint){0, 49}, (RadarPoint){200, 49}, box));     // above it
  // a short segment is tested at its ends and its middle only
  CHECK(radar_label_segment_hits((RadarPoint){46, 60}, (RadarPoint){54, 60}, box));
  CHECK(!radar_label_segment_hits((RadarPoint){44, 44}, (RadarPoint){49, 49}, box));
}

static void test_avoids_flight_path(void) {
  // The path comes in from the right, through the first-choice place: the box goes to the next free one.
  RadarPoint at = {100, 100};
  RadarPoint trail[] = {{60, -20}, {30, -17}, {10, -15}};            // offsets from ORIGIN: (160,94) (130,97) (110,99)
  CHECK_AT(radar_label_place(at, 50, 18, RECT, ORIGIN, trail, 3), 110, 106);
  // without the path the first choice stands
  CHECK_AT(radar_label_place(at, 50, 18, RECT, ORIGIN, trail, 0), 110, 92);
  CHECK_AT(radar_label_place(at, 50, 18, RECT, ORIGIN, NULL, 3), 110, 92);
  // the last leg, from the newest trail point to the aircraft, counts too
  RadarPoint behind[] = {{50, -14}};                                 // (150,100): straight in from the right
  CHECK_AT(radar_label_place(at, 50, 18, RECT, ORIGIN, behind, 1), 110, 106);
  // a path through both places on the right sends the box to the left
  RadarPoint wide[] = {{60, -14}, {40, -4}, {30, -10}, {12, -12}};
  CHECK_AT(radar_label_place(at, 50, 18, RECT, ORIGIN, wide, 4), 40, 92);
}

static void test_round_screen(void) {
  // a box fits when its corners are within the circle, 2 px in
  CHECK(radar_label_fits_round((RadarBox){105, 121, 50, 18}, 260, 260));
  CHECK(!radar_label_fits_round((RadarBox){200, 30, 50, 18}, 260, 260));
  CHECK(radar_label_fits_round((RadarBox){40, 40, 180, 180}, 260, 260));  // corners 127.3 px from the centre
  CHECK(!radar_label_fits_round((RadarBox){39, 39, 182, 182}, 260, 260)); // 128.7 px
  // near the rim the candidates that stick out of the circle are skipped
  CHECK_AT(place((RadarPoint){190, 50}, 50, 18, ROUND), 130, 42);        // left of it: both places on the right stick out
  CHECK_AT(place((RadarPoint){190, 50}, 50, 18, (RadarScreen){260, 260, false}), 200, 42);
  // nothing fits: from up-right of the aircraft the box walks towards the centre until it is inside
  // (a 170 x 120 box for an aircraft at the right rim starts at (88, 122) and takes 16 steps of 4 px)
  RadarPoint big = place((RadarPoint){250, 130}, 170, 120, ROUND);
  CHECK(!radar_label_fits_round((RadarBox){88, 122, 170, 120}, 260, 260));
  CHECK(radar_label_fits_round((RadarBox){big.x, big.y, 170, 120}, 260, 260));
  CHECK_AT(big, 60, 86);
  // on a rectangular screen of that size the box has room left of the aircraft
  CHECK_AT(place((RadarPoint){250, 130}, 170, 120, (RadarScreen){260, 260, false}), 70, 122);
}

int main(void) {
  test_first_choice();
  test_candidates_in_order();
  test_edges_are_exact();
  test_fallback();
  test_segment_hits();
  test_avoids_flight_path();
  test_round_screen();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
