import { describe, expect, it } from 'vitest';
import { classifyDurableFilesystem, parseMountInfo } from '../src/durable-filesystem.js';

function mountLine({
  mountRoot,
  mountPoint = '/durable',
  filesystemType = 'ext4',
  mountSource = '/dev/nvme0n1p1',
}: {
  mountRoot: string;
  mountPoint?: string;
  filesystemType?: string;
  mountSource?: string;
}): string {
  return `42 27 259:1 ${mountRoot} ${mountPoint} rw,relatime shared:1 - ${filesystemType} ${mountSource} rw`;
}

describe('Stage 3 lifecycle-managed mount attestation', () => {
  it('refuses a disk-backed emptyDir/bind subtree even when the backing filesystem is ext4', () => {
    const [boundary] = parseMountInfo(
      mountLine({ mountRoot: '/var/lib/kubelet/pods/pod-id/volumes/kubernetes.io~empty-dir/hq' }),
    );

    expect(boundary).toMatchObject({
      mountRoot: '/var/lib/kubelet/pods/pod-id/volumes/kubernetes.io~empty-dir/hq',
      mountPoint: '/durable',
      filesystemType: 'ext4',
      mountSource: '/dev/nvme0n1p1',
    });
    expect(classifyDurableFilesystem(boundary!)).toMatchObject({
      durable: false,
      refusal: 'lifecycle-managed',
    });
  });

  it('refuses the same lifecycle-managed subtree even when its filesystem type is operator-attested', () => {
    const [boundary] = parseMountInfo(
      mountLine({
        mountRoot: '/var/lib/kubelet/pods/pod-id/volumes/kubernetes.io~empty-dir/hq',
        filesystemType: 'customfs',
        mountSource: '/dev/custom-device',
      }),
    );

    expect(classifyDurableFilesystem(boundary!, ['customfs'])).toMatchObject({
      durable: false,
      refusal: 'lifecycle-managed',
    });
  });

  it('continues to accept a supported whole-filesystem mount', () => {
    const [boundary] = parseMountInfo(mountLine({ mountRoot: '/' }));

    expect(classifyDurableFilesystem(boundary!)).toEqual({
      durable: true,
      basis: 'known-persistent',
    });
  });
});
