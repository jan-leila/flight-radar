import os.path

top = '.'
out = 'build'

def options(ctx):
    ctx.load('pebble_sdk')

def configure(ctx):
    ctx.load('pebble_sdk')
    # The SDK names the bundle after the checkout directory; pin it so scripts can rely on build/plane-watch.pbw.
    ctx.env.BUNDLE_NAME = 'plane-watch.pbw'

def build(ctx):
    ctx.load('pebble_sdk')
    binaries = []
    cached_env = ctx.env
    for p in ctx.env.TARGET_PLATFORMS:
        ctx.set_env(ctx.all_envs[p])
        ctx.set_group(ctx.env.PLATFORM_NAME)
        app_elf = '{}/pebble-app.elf'.format(ctx.env.BUILD_DIR)
        ctx.pbl_build(source=ctx.path.ant_glob('src/c/**/*.c'), target=app_elf, bin_type='app')
        binaries.append({'platform': p, 'app_elf': app_elf})
    ctx.set_env(cached_env)
    ctx.set_group('bundle')
    # PKJS_ENTRY swaps the phone side for a test fixture (tools/screenshots.sh, tools/test-app-emulator.sh).
    ctx.pbl_bundle(binaries=binaries,
                   js=ctx.path.ant_glob(['src/pkjs/**/*.js', 'src/common/**/*.js']),
                   js_entry_file=os.environ.get('PKJS_ENTRY', 'src/pkjs/index.js'))
