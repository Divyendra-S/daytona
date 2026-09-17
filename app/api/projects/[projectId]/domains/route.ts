import { NextResponse } from "next/server";
import {
  cnameTarget,
  connectDomain,
  customDomainsEnabled,
  listDomains,
  removeDomain,
} from "@/lib/custom-domains";
import { authorizeProject } from "@/lib/project-access";

type Params = { params: Promise<{ projectId: string }> };

const forbidden = () =>
  NextResponse.json({ error: "Forbidden" }, { status: 403 });

const failed = (error: unknown, fallback: string) =>
  NextResponse.json(
    { error: error instanceof Error ? error.message : fallback },
    { status: 400 },
  );

/** What the publish dialog shows, and polls while a domain is pending. */
const answer = async (projectId: string) =>
  NextResponse.json({
    enabled: customDomainsEnabled(),
    cnameTarget: cnameTarget(),
    domains: await listDomains(projectId),
  });

export async function GET(_req: Request, { params }: Params) {
  const { projectId } = await params;
  if (!(await authorizeProject(projectId))) return forbidden();

  try {
    return await answer(projectId);
  } catch (error) {
    return failed(error, "Could not read the project's domains.");
  }
}

export async function POST(req: Request, { params }: Params) {
  const { projectId } = await params;
  if (!(await authorizeProject(projectId))) return forbidden();

  const payload = (await req.json().catch(() => ({}))) as {
    hostname?: string;
  };
  try {
    await connectDomain(projectId, payload.hostname ?? "");
    return await answer(projectId);
  } catch (error) {
    return failed(error, "Could not connect the domain.");
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const { projectId } = await params;
  if (!(await authorizeProject(projectId))) return forbidden();

  const payload = (await req.json().catch(() => ({}))) as {
    hostname?: string;
  };
  try {
    await removeDomain(
      projectId,
      (payload.hostname ?? "").trim().toLowerCase(),
    );
    return await answer(projectId);
  } catch (error) {
    return failed(error, "Could not remove the domain.");
  }
}
