// Resolves the final Docker image reference from a service start spec.
// Priority: dockerfile > checksum > tag > default "latest".
export function resolveServiceImage(
  image: string,
  tag?: string,
  checksum?: string,
  dockerfile?: string,
  serviceId?: string
): string {
  if (dockerfile) return `${serviceId!.toLowerCase()}-svc-image:latest`
  if (checksum) return `${image}@${checksum}`
  return `${image}:${tag ?? 'latest'}`
}
