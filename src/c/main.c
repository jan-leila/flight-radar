// Plane Watch for Pebble: the window, the drawing, the buttons and the messages. The state lives in
// radar_model.c and the label geometry in radar_label.c; both are plain C and tested on the host.
#include <pebble.h>
#include "radar_label.h"
#include "radar_model.h"

#define INBOX_SIZE 4096
#define OUTBOX_SIZE 256

#define HELLO_DELAY_MS 250
#define HELLO_RETRY_MS 2000
#define REFRESH_MS 30000
#define SELECT_SEND_DELAY_MS 300      // lets a run of UP/DOWN presses settle before asking for a flight path
#define NO_TRAFFIC_MS 1800
#define HELLO_VISIBLE_MI 20

#define STATUS_CENTER_W 200
#define STATUS_CENTER_H 28
#define STATUS_BOTTOM_INSET 30
#define STATUS_BOTTOM_H 26

#define PLANE_MARGIN 16               // planes up to this far off screen are still drawn
#define LABEL_MARGIN_X 20             // unselected planes this close to an edge get no label
#define LABEL_MARGIN_TOP 15
#define LABEL_MARGIN_BOTTOM 14
#define LABEL_SPACING_SQ 576          // labelled planes are at least 24 px apart
#define LABEL_PAD_X 3
#define LABEL_CORNER 2

static const uint16_t ZOOM_MILES[] = {5, 10, 20, 40};
// Arrowhead pointing north, around the plane's position.
static const GPoint PLANE_SHAPE[] = {{0, -7}, {6, 6}, {0, 3}, {-6, 6}};

typedef struct {
  const char *text;
  GColor color;
} LabelLine;

static Window *s_window;
static Layer *s_map_layer;
static TextLayer *s_status_layer;
static GRect s_status_center, s_status_bottom;
static AppTimer *s_status_timer, *s_select_timer, *s_refresh_timer;
static RadarModel s_model;
static unsigned s_zoom = 2;

// ---- status line ---------------------------------------------------------------------------------------------

// Centred while there is no map yet, across the lower part of the map afterwards.
static void show_status(void) {
  if (!s_status_layer) return;
  Layer *layer = text_layer_get_layer(s_status_layer);
  if (!s_model.status[0]) {
    layer_set_hidden(layer, true);
    return;
  }
  text_layer_set_text(s_status_layer, s_model.status);
  layer_set_frame(layer, s_model.have_view ? s_status_bottom : s_status_center);
  layer_set_hidden(layer, false);
}

static void stop_status_timer(void) {
  if (s_status_timer) {
    app_timer_cancel(s_status_timer);
    s_status_timer = NULL;
  }
}

static void status_timer_fired(void *context) {
  s_status_timer = NULL;
  s_model.status[0] = 0;
  show_status();
}

static void apply(unsigned actions) {
  if (actions & RADAR_STOP_STATUS_TIMER) stop_status_timer();
  if (actions & RADAR_STATUS) show_status();
  if (actions & RADAR_LOG) APP_LOG(APP_LOG_LEVEL_ERROR, "%s", s_model.status);
  if ((actions & RADAR_REDRAW) && s_map_layer) layer_mark_dirty(s_map_layer);
}

// ---- messages ------------------------------------------------------------------------------------------------

static void send_command(int32_t command, int32_t value) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  dict_write_int(out, MESSAGE_KEY_CMD, &command, sizeof(command), true);
  dict_write_int(out, MESSAGE_KEY_VAL, &value, sizeof(value), true);
  app_message_outbox_send();
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *payload = dict_find(iter, MESSAGE_KEY_PAYLOAD);
  if (!payload || payload->type != TUPLE_BYTE_ARRAY) return;
  apply(radar_model_receive(&s_model, payload->value->data, payload->length));
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "inbox dropped %d", (int)reason);
  apply(radar_model_dropped(&s_model, (int)reason));
}

// Tells the phone the screen size and asks for the first view, until the phone answers.
static void hello_timer_fired(void *context) {
  if (s_model.phone_seen) return;
  int w = 200, h = 200;
  if (s_map_layer) {
    GRect bounds = layer_get_bounds(s_map_layer);
    w = bounds.size.w;
    h = bounds.size.h;
  }
  send_command(RADAR_CMD_HELLO, ((w & 0x3ff) << 12) | (h << 22) | HELLO_VISIBLE_MI);
  app_timer_register(HELLO_RETRY_MS, hello_timer_fired, NULL);
}

static void refresh_timer_fired(void *context) {
  send_command(RADAR_CMD_REFRESH_PLANES, 0);
  s_refresh_timer = app_timer_register(REFRESH_MS, refresh_timer_fired, NULL);
}

static void select_timer_fired(void *context) {
  s_select_timer = NULL;
  if (!s_model.selection_active) return;
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) != APP_MSG_OK) return;
  uint8_t request[4] = {RADAR_SUBCMD_SELECT, s_model.selected_hex[0], s_model.selected_hex[1], s_model.selected_hex[2]};
  dict_write_data(out, MESSAGE_KEY_PAYLOAD, request, sizeof(request));
  app_message_outbox_send();
}

// ---- buttons -------------------------------------------------------------------------------------------------

static void step_selection(int dir) {
  switch (radar_model_step(&s_model, dir, PBL_IF_ROUND_ELSE(true, false))) {
    case RADAR_STEP_SELECTED:
      if (s_select_timer) app_timer_cancel(s_select_timer);
      s_select_timer = app_timer_register(SELECT_SEND_DELAY_MS, select_timer_fired, NULL);
      layer_mark_dirty(s_map_layer);
      break;
    case RADAR_STEP_NO_TRAFFIC:
      show_status();
      if (s_status_timer) app_timer_cancel(s_status_timer);
      s_status_timer = app_timer_register(NO_TRAFFIC_MS, status_timer_fired, NULL);
      break;
    case RADAR_STEP_NONE:
      break;
  }
}

static void up_click(ClickRecognizerRef recognizer, void *context) { step_selection(1); }
static void down_click(ClickRecognizerRef recognizer, void *context) { step_selection(-1); }

static void select_click(ClickRecognizerRef recognizer, void *context) {
  s_zoom = (s_zoom + 1) % ARRAY_LENGTH(ZOOM_MILES);
  snprintf(s_model.status, sizeof(s_model.status), "%dmi (rendering...)", ZOOM_MILES[s_zoom]);
  show_status();
  send_command(RADAR_CMD_VIEW, ZOOM_MILES[s_zoom]);
}

// BACK drops the selection first and leaves the app when nothing is selected.
static void back_click(ClickRecognizerRef recognizer, void *context) {
  if (s_model.selected < 0) {
    window_stack_pop_all(true);
    return;
  }
  radar_model_deselect(&s_model);
  if (s_select_timer) {
    app_timer_cancel(s_select_timer);
    s_select_timer = NULL;
  }
  layer_mark_dirty(s_map_layer);
}

static void click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_UP, up_click);
  window_single_click_subscribe(BUTTON_ID_DOWN, down_click);
  window_single_click_subscribe(BUTTON_ID_SELECT, select_click);
  window_single_click_subscribe(BUTTON_ID_BACK, back_click);
}

// ---- drawing -------------------------------------------------------------------------------------------------

// A black box with up to four lines of text next to the aircraft at `at`.
static void draw_label(GContext *ctx, const LabelLine *lines, int count, GFont font, GPoint at, GRect bounds,
                       GPoint center, const RadarPoint *trail, int trail_n) {
  GRect screen = GRect(0, 0, bounds.size.w, bounds.size.h);
  int line_h = graphics_text_layout_get_content_size("Ag", font, screen, GTextOverflowModeWordWrap, GTextAlignmentLeft).h;
  int text_w = 0;
  for (int i = 0; i < count; i++) {
    if (!lines[i].text[0]) continue;
    int w = graphics_text_layout_get_content_size(lines[i].text, font, screen, GTextOverflowModeWordWrap, GTextAlignmentLeft).w;
    if (w > text_w) text_w = w;
  }
  if (text_w == 0) return;

  int box_w = text_w + 2 * LABEL_PAD_X;
  int text_h = line_h * count;
  RadarScreen radar_screen = {bounds.size.w, bounds.size.h, PBL_IF_ROUND_ELSE(true, false)};
  RadarPoint corner = radar_label_place((RadarPoint){at.x, at.y}, box_w, text_h + 4, radar_screen,
                                        (RadarPoint){center.x, center.y}, trail, trail_n);

  // The font's ascent leaves the glyphs 2 px below the top of their box.
  graphics_context_set_fill_color(ctx, GColorBlack);
  graphics_fill_rect(ctx, GRect(corner.x, corner.y + 2, box_w, text_h), LABEL_CORNER, GCornersAll);
  for (int i = 0; i < count; i++) {
    if (!lines[i].text[0]) continue;
    graphics_context_set_text_color(ctx, lines[i].color);
    graphics_draw_text(ctx, lines[i].text, font, GRect(corner.x + LABEL_PAD_X, corner.y + i * line_h, text_w + 1, line_h + 4),
                       GTextOverflowModeWordWrap, GTextAlignmentLeft, NULL);
  }
}

static void copy_field(char *out, const char *field, size_t length) {
  memcpy(out, field, length);
  out[length] = 0;
}

static void draw_plane(GContext *ctx, GPoint center, const RadarPlane *plane, const RadarPoint *trail, GFont font,
                       bool label, bool selected, GRect bounds) {
  int w = bounds.size.w, h = bounds.size.h;
  GPoint at = GPoint(plane->x + center.x, plane->y + center.y);
  if (at.x < -PLANE_MARGIN || at.x > w + PLANE_MARGIN || at.y < -PLANE_MARGIN || at.y > h + PLANE_MARGIN) return;

  if (selected && trail && plane->trail_n) {
    graphics_context_set_stroke_color(ctx, GColorIslamicGreen);
    graphics_context_set_stroke_width(ctx, 2);
    GPoint from = GPoint(trail[0].x + center.x, trail[0].y + center.y);
    for (int k = 1; k < plane->trail_n; k++) {
      GPoint to = GPoint(trail[k].x + center.x, trail[k].y + center.y);
      graphics_draw_line(ctx, from, to);
      from = to;
    }
    graphics_draw_line(ctx, from, at);
  }

  int32_t angle = plane->track << 8;
  int32_t cosine = cos_lookup(angle), sine = sin_lookup(angle);
  GPoint points[ARRAY_LENGTH(PLANE_SHAPE)];
  for (unsigned i = 0; i < ARRAY_LENGTH(PLANE_SHAPE); i++) {
    int x = PLANE_SHAPE[i].x, y = PLANE_SHAPE[i].y;
    points[i].x = (x * cosine - y * sine) / TRIG_MAX_RATIO + at.x;
    points[i].y = (x * sine + y * cosine) / TRIG_MAX_RATIO + at.y;
  }
  GColor fill = selected ? GColorIslamicGreen
              : plane->alt_class == 1 ? GColorRed
              : plane->alt_class == 2 ? GColorPictonBlue
              : GColorOrange;
  graphics_context_set_fill_color(ctx, fill);
  GPath *path = gpath_create(&(GPathInfo){.num_points = ARRAY_LENGTH(points), .points = points});
  gpath_draw_filled(ctx, path);
  if (selected) {
    graphics_context_set_stroke_color(ctx, GColorWhite);
    graphics_context_set_stroke_width(ctx, 1);
    gpath_draw_outline(ctx, path);
  }
  gpath_destroy(path);

  char hex[8];
  snprintf(hex, sizeof(hex), "%02X%02X%02X", plane->hex[0], plane->hex[1], plane->hex[2]);
  char callsign[sizeof(plane->callsign) + 1];
  copy_field(callsign, plane->callsign, sizeof(plane->callsign));

  if (!selected) {
    if (!label) return;
    if (at.x <= LABEL_MARGIN_X || at.x >= w - LABEL_MARGIN_X || at.y < LABEL_MARGIN_TOP || at.y >= h - LABEL_MARGIN_BOTTOM) return;
    // The address stands in, greyed, for a plane that sends no callsign.
    LabelLine line = callsign[0] ? (LabelLine){callsign, GColorWhite} : (LabelLine){hex, GColorLightGray};
    draw_label(ctx, &line, 1, font, at, bounds, center, NULL, 0);
    return;
  }

  char tail[sizeof(plane->tail) + 1], type[sizeof(plane->type) + 1];
  copy_field(tail, plane->tail, sizeof(plane->tail));
  copy_field(type, plane->type, sizeof(plane->type));
  char type_tail[20], altitude[16], speed[12];
  snprintf(type_tail, sizeof(type_tail), "%s %s", type[0] ? type : "no type", tail[0] ? tail : "no tail");
  radar_format_altitude(plane->alt100, altitude, sizeof(altitude));
  snprintf(speed, sizeof(speed), "%dkt", plane->gs);
  // Orange marks what the plane does not say about itself.
  LabelLine lines[] = {
    callsign[0] ? (LabelLine){callsign, GColorIslamicGreen} : (LabelLine){hex, GColorOrange},
    {type_tail, type[0] && tail[0] ? GColorIslamicGreen : GColorOrange},
    {altitude, GColorIslamicGreen},
    {speed, GColorIslamicGreen},
  };
  draw_label(ctx, lines, ARRAY_LENGTH(lines), font, at, bounds, center, trail, plane->trail_n);
}

// Copies the map straight into the frame buffer: one byte per pixel on both sides.
static void draw_map(GContext *ctx) {
  GBitmap *frame = graphics_capture_frame_buffer(ctx);
  if (!frame) return;
  for (int y = 0; y < s_model.height; y++) {
    GBitmapDataRowInfo row = gbitmap_get_data_row_info(frame, y);
    if (row.min_x <= row.max_x) {
      memcpy(row.data + row.min_x, s_model.pixels + y * s_model.width + row.min_x, row.max_x - row.min_x + 1);
    }
  }
  graphics_release_frame_buffer(ctx, frame);
}

static void map_update(Layer *layer, GContext *ctx) {
  GRect bounds = layer_get_bounds(layer);
  GPoint center = grect_center_point(&bounds);
  graphics_context_set_antialiased(ctx, true);
  if (s_model.pixels && s_model.have_view) {
    draw_map(ctx);
  } else {
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
  }
  if (!s_model.have_view) return;

  GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
  // In list order (closest first), a plane is labelled unless a labelled one is within 24 px of it.
  GPoint labelled[RADAR_MAX_PLANES];
  int labelled_n = 0;
  for (int i = 0; i < s_model.plane_count; i++) {
    if (i == s_model.selected) continue;
    const RadarPlane *plane = &s_model.planes[i];
    GPoint at = GPoint(plane->x + center.x, plane->y + center.y);
    bool label = true;
    for (int k = 0; k < labelled_n && label; k++) {
      int dx = labelled[k].x - at.x, dy = labelled[k].y - at.y;
      label = dx * dx + dy * dy >= LABEL_SPACING_SQ;
    }
    if (label && labelled_n < RADAR_MAX_PLANES) labelled[labelled_n++] = at;
    draw_plane(ctx, center, plane, NULL, font, label, false, bounds);
  }
  // The selected plane goes on top, with its flight path and details.
  if (s_model.selected >= 0 && s_model.selected < s_model.plane_count) {
    draw_plane(ctx, center, &s_model.planes[s_model.selected], s_model.trails[s_model.selected], font, true, true, bounds);
  }
}

// ---- window --------------------------------------------------------------------------------------------------

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  int w = bounds.size.w, h = bounds.size.h;
  apply(radar_model_set_screen(&s_model, w, h));

  s_map_layer = layer_create(bounds);
  layer_set_update_proc(s_map_layer, map_update);
  layer_add_child(root, s_map_layer);

  s_status_center = GRect((w - STATUS_CENTER_W) / 2, (h - STATUS_CENTER_H) / 2, STATUS_CENTER_W, STATUS_CENTER_H);
  s_status_bottom = GRect(STATUS_BOTTOM_INSET, h * 3 / 4 - STATUS_BOTTOM_H / 2, w - 2 * STATUS_BOTTOM_INSET, STATUS_BOTTOM_H);
  s_status_layer = text_layer_create(s_status_center);
  text_layer_set_background_color(s_status_layer, GColorBlack);
  text_layer_set_text_color(s_status_layer, GColorWhite);
  text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
  text_layer_set_font(s_status_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text(s_status_layer, s_model.status);
  layer_add_child(root, text_layer_get_layer(s_status_layer));
  layer_set_hidden(text_layer_get_layer(s_status_layer), !s_model.status[0]);

  window_set_click_config_provider(window, click_config);
}

static void window_unload(Window *window) {
  text_layer_destroy(s_status_layer);
  layer_destroy(s_map_layer);
  radar_model_free_pixels(&s_model);
}

int main(void) {
  radar_model_init(&s_model);
  s_window = window_create();
  window_set_background_color(s_window, GColorBlack);
  window_set_window_handlers(s_window, (WindowHandlers){.load = window_load, .unload = window_unload});
  window_stack_push(s_window, true);

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_open(INBOX_SIZE, OUTBOX_SIZE);

  if (!s_model.error) {
    strcpy(s_model.status, "Locating...");
    show_status();
  }
  app_timer_register(HELLO_DELAY_MS, hello_timer_fired, NULL);
  s_refresh_timer = app_timer_register(REFRESH_MS, refresh_timer_fired, NULL);

  app_event_loop();

  if (s_refresh_timer) app_timer_cancel(s_refresh_timer);
  stop_status_timer();
  radar_model_free_transfer(&s_model);
  window_destroy(s_window);
  return 0;
}
