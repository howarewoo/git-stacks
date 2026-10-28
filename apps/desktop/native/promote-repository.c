/*
 * promote-repository <staging> <destination>
 *
 * Moves a finished clone into its destination with one syscall that refuses to
 * replace anything already there. The commit point of a clone is this rename,
 * and it is a single atomic no-replace operation on macOS:
 * renamex_np(RENAME_EXCL). Arguments are filesystem byte sequences.
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

/* The exit codes this helper promises; see the header comment. */
#define EXIT_MOVED 0
#define EXIT_FAILED 1
#define EXIT_USAGE 2
#define EXIT_DESTINATION_EXISTS 3
#define EXIT_UNSUPPORTED 4
#define EXIT_CROSS_DEVICE 5

/* How a failed rename is reported. Every platform reaches the same codes. */
static int exit_code(int failure) {
  switch (failure) {
    case EEXIST:
    case ENOTEMPTY:
      return EXIT_DESTINATION_EXISTS;
    /* ENOSYS is a kernel without renameat2; EINVAL and ENOTSUP are a filesystem
     * that does not implement the flag. Neither falls back. */
    case ENOSYS:
    case EINVAL:
    case ENOTSUP:
      return EXIT_UNSUPPORTED;
    case EXDEV:
      return EXIT_CROSS_DEVICE;
    default:
      return EXIT_FAILED;
  }
}

#if defined(__APPLE__)

#include <stdlib.h>

/* RENAME_EXCL is the documented flag: fail rather than replace the target. */
#ifndef RENAME_EXCL
#define RENAME_EXCL 0x00000004
#endif

static int rename_no_replace(const char *from, const char *to) {
  return renamex_np(from, to, RENAME_EXCL);
}

/** POSIX argv is already the byte sequence the filesystem takes, so a path is
 * passed through without any encoding conversion. */
static int run(const char *from, const char *to) {
  if (rename_no_replace(from, to) == 0) return EXIT_MOVED;
  fprintf(stderr, "%s -> %s: %s\n", from, to, strerror(errno));
  return exit_code(errno);
}

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: promote-repository <staging> <destination>\n");
    return EXIT_USAGE;
  }
  return run(argv[1], argv[2]);
}


#else

static int run(const char *from, const char *to) {
  (void)from;
  (void)to;
  return exit_code(ENOSYS);
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 3) {
    fprintf(stderr, "usage: promote-repository <staging> <destination>\n");
    return EXIT_USAGE;
  }
  return run(argv[1], argv[2]);
}

#endif
