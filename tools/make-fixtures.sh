#!/usr/bin/env bash
# Regenerates the small test clips in tests/fixtures/ (needs ffmpeg with libx264 and libx265).
# The clips are committed; this script only documents how they were made.
set -euo pipefail
cd "$(dirname "$0")/../tests/fixtures"

TAGS="-vf setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"
SRC="testsrc2=size=320x180"
FF="ffmpeg -hide_banner -loglevel error -y"

# Accepted: what Resolve renders. B-frames on, 1 s GOP, bt709 tags.
$FF -f lavfi -i "$SRC:rate=24000/1001" -frames:v 72 -c:v libx264 -profile:v high -bf 3 -g 24 -pix_fmt yuv420p $TAGS h264_2398_bframes.mp4
$FF -f lavfi -i "$SRC:rate=25" -frames:v 50 -c:v libx264 -profile:v high -bf 2 -g 25 -pix_fmt yuv420p $TAGS -use_editlist 0 h264_25_offset.mp4
$FF -f lavfi -i "$SRC:rate=30000/1001" -frames:v 45 -c:v libx264 -profile:v high -g 30 -pix_fmt yuv420p $TAGS h264_2997.mov
$FF -f lavfi -i "$SRC:rate=60000/1001" -frames:v 60 -c:v libx264 -profile:v high -g 60 -pix_fmt yuv420p $TAGS h264_5994.mp4

# Natural footage: a slow pan across a photo with two people (ultralytics sample zidane.jpg, AGPL-3.0),
# for colour-fidelity checks and later for person detection.
$FF -loop 1 -framerate 24 -i zidane.jpg -frames:v 48     -vf "scale=960:-2,crop=640:360:x='40+t*60':y=90,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"     -c:v libx264 -profile:v high -crf 20 -g 24 -pix_fmt yuv420p h264_24_natural.mp4

# Audio sync: white flash frames 12 and 30 with a 1 kHz beep starting on each. The video starts one
# frame after the audio (as in YouTube-sourced renders), so the export has to shift the audio to match.
# AAC in MP4, and 16-bit PCM in MOV (what Resolve writes).
AV_V="color=black:s=320x180:r=24:d=2,drawbox=c=white:t=fill:enable='eq(n,12)+eq(n,30)'"
AV_A="aevalsrc='if(between(t,1/24+0.5,1/24+0.55)+between(t,1/24+1.25,1/24+1.3),0.8*sin(2*PI*1000*t),0)':s=48000:d=2.2"
$FF -itsoffset 0.0416667 -f lavfi -i "$AV_V" -f lavfi -i "$AV_A" -c:v libx264 -profile:v high -g 24 -pix_fmt yuv420p $TAGS -c:a aac -b:a 192k av_sync.mp4
$FF -itsoffset 0.0416667 -f lavfi -i "$AV_V" -f lavfi -i "$AV_A" -c:v libx264 -profile:v high -g 24 -pix_fmt yuv420p $TAGS -c:a pcm_s16le av_sync_pcm.mov

# Rejected.
$FF -f lavfi -i "$SRC:rate=24" -frames:v 24 -c:v libx265 -pix_fmt yuv420p10le -x265-params log-level=none hevc_10bit.mp4
$FF -f lavfi -i "$SRC:rate=24" -frames:v 24 -c:v libx264 -profile:v high10 -pix_fmt yuv420p10le h264_10bit.mp4
$FF -f lavfi -i "$SRC:rate=24:duration=1" -f lavfi -i "$SRC:rate=30:duration=1" \
    -filter_complex "[0][1]concat=n=2:v=1" -fps_mode passthrough -c:v libx264 -pix_fmt yuv420p h264_vfr.mp4
$FF -f lavfi -i "$SRC:rate=24" -frames:v 24 -c:v libvpx-vp9 vp9.webm

ls -la
