import os, sys, time, statistics
path = sys.argv[1]; n = int(sys.argv[2]); size = int(sys.argv[3])
buf = os.urandom(size)
fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
# warm up
for _ in range(50):
    os.write(fd, buf); os.fdatasync(fd); os.lseek(fd, 0, os.SEEK_SET)
lat = []
for _ in range(n):
    os.lseek(fd, 0, os.SEEK_SET)
    t = time.perf_counter_ns()
    os.write(fd, buf); os.fdatasync(fd)
    lat.append((time.perf_counter_ns() - t) / 1000.0)  # us
os.close(fd); os.unlink(path)
lat.sort()
q = lambda p: lat[min(len(lat)-1, int(len(lat)*p))]
print(f"{size}B x {n}: mean {statistics.fmean(lat):.1f} us  p50 {q(0.5):.1f}  p90 {q(0.9):.1f}  p99 {q(0.99):.1f}  max {lat[-1]:.1f}  -> {1e6/statistics.fmean(lat):.0f} fsync/s")
