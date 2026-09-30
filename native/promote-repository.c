/*
 * promote-repository <staging> <destination>
 *
 * Moves a finished clone into its destination with one syscall that refuses to
 * replace anything already there. The commit point of a clone is this rename,
 * and it is a single atomic no-replace operation on every supported platform:
 *
 *   Darwin  renamex_np(RENAME_EXCL)
 *   Linux   renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE)
 *   Windows MoveFileExW without MOVEFILE_REPLACE_EXISTING
 *
 * There is deliberately no fallback. A platform or filesystem without a
 * no-replace rename is reported as unsupported (exit 4) so the caller can refuse
 * the promotion; a check-then-rename would claim a guarantee the filesystem does
 * not make, and would destroy a directory another program owns.
 *
 * Exit codes
 *   0  moved
 *   2  usage
 *   3  the destination already exists (the no-replace refusal)
 *   4  this kernel or filesystem has no no-replace rename
 *   5  staging and destination are on different filesystems
 *   1  any other failure, with the reason on stderr
 */

#include <errno.h>
#include <stdio.h>
#include <string.h>

#ifndef ENOTSUP
#define ENOTSUP EOPNOTSUPP
#endif

#if defined(_WIN32)

#include <stdlib.h>
#include <windows.h>

#ifndef MOVEFILE_WRITE_THROUGH
#define MOVEFILE_WRITE_THROUGH 0x00000008
#endif

static wchar_t *widen(const char *value) {
  int size = MultiByteToWideChar(CP_UTF8, 0, value, -1, NULL, 0);
  if (size <= 0) return NULL;
  wchar_t *wide = (wchar_t *)malloc((size_t)size * sizeof(wchar_t));
  if (wide == NULL) return NULL;
  if (MultiByteToWideChar(CP_UTF8, 0, value, -1, wide, size) <= 0) {
    free(wide);
    return NULL;
  }
  return wide;
}

static int rename_no_replace(const char *from, const char *to) {
  wchar_t *wide_from = widen(from);
  wchar_t *wide_to = widen(to);
  if (wide_from == NULL || wide_to == NULL) {
    free(wide_from);
    free(wide_to);
    errno = ENOMEM;
    return -1;
  }
  /* Without MOVEFILE_REPLACE_EXISTING the move fails when the target exists. */
  int moved = MoveFileExW(wide_from, wide_to, MOVEFILE_WRITE_THROUGH);
  DWORD failure = moved ? 0 : GetLastError();
  free(wide_from);
  free(wide_to);
  if (moved) return 0;
  if (failure == ERROR_ALREADY_EXISTS || failure == ERROR_FILE_EXISTS) errno = EEXIST;
  else if (failure == ERROR_NOT_SAME_DEVICE) errno = EXDEV;
  else if (failure == ERROR_NOT_SUPPORTED) errno = ENOTSUP;
  else errno = EIO;
  return -1;
}

#elif defined(__APPLE__)

#include <stdlib.h>

/* RENAME_EXCL is the documented flag: fail rather than replace the target. */
#ifndef RENAME_EXCL
#define RENAME_EXCL 0x00000004
#endif

static int rename_no_replace(const char *from, const char *to) {
  return renamex_np(from, to, RENAME_EXCL);
}

#elif defined(__linux__)

#include <fcntl.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif

static int rename_no_replace(const char *from, const char *to) {
#ifdef SYS_renameat2
  /* Called through syscall() so the helper also builds against a libc older
   * than 2.28, which is where the renameat2 wrapper was introduced. */
  return (int)syscall(SYS_renameat2, AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE);
#else
  errno = ENOSYS;
  return -1;
#endif
}

#else

static int rename_no_replace(const char *from, const char *to) {
  (void)from;
  (void)to;
  errno = ENOSYS;
  return -1;
}

#endif

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: promote-repository <staging> <destination>\n");
    return 2;
  }
  if (rename_no_replace(argv[1], argv[2]) == 0) return 0;
  switch (errno) {
    case EEXIST:
    case ENOTEMPTY:
      return 3;
    /* ENOSYS is a kernel without renameat2; EINVAL and ENOTSUP are a
     * filesystem that does not implement the flag. Neither falls back. */
    case ENOSYS:
    case EINVAL:
    case ENOTSUP:
      return 4;
    case EXDEV:
      return 5;
    default:
      fprintf(stderr, "%s -> %s: %s\n", argv[1], argv[2], strerror(errno));
      return 1;
  }
}
