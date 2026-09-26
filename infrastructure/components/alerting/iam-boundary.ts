import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { requireEnv } from "../shared/env";

export interface AlertingPlaneBoundaryArgs {
  env: string;
  platformTableArn: pulumi.Input<string>;
  incidentTableArn: pulumi.Input<string>;
}

/**
 * IAM permissions boundary attached to every alerting-service role (E1-S13-INFRA).
 * Alerting isolation is an IAM boundary, not a naming convention (CLAUDE.md): this
 * explicitly denies DynamoDB access to the platform-service and incident-service
 * tables (and their indexes/streams) regardless of what any role's own policy grants.
 */
export class AlertingPlaneBoundary extends pulumi.ComponentResource {
  public readonly policy: aws.iam.Policy;

  constructor(
    name: string,
    args: AlertingPlaneBoundaryArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    requireEnv("AlertingPlaneBoundary", args.env);
    super("boxalarm:alerting:AlertingPlaneBoundary", name, {}, opts);
    const { env } = args;

    // Streams are denied by wildcard, not by the current stream ARN: disabling and
    // re-enabling a table's stream mints a new label, and a pinned ARN would silently stop
    // covering it.
    const deniedTableResources = pulumi
      .all([args.platformTableArn, args.incidentTableArn])
      .apply(([platformTableArn, incidentTableArn]) => [
        platformTableArn,
        `${platformTableArn}/index/*`,
        `${platformTableArn}/stream/*`,
        incidentTableArn,
        `${incidentTableArn}/index/*`,
        `${incidentTableArn}/stream/*`,
      ]);

    this.policy = new aws.iam.Policy(
      `${name}-policy`,
      {
        name: `boxalarm-${env}-alerting-plane-boundary`,
        description:
          "Permissions boundary for alerting-service roles: denies all DynamoDB access to the platform-service and incident-service tables regardless of the role's own policy.",
        policy: deniedTableResources.apply((resources) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              { Sid: "AllowEverythingElse", Effect: "Allow", Action: "*", Resource: "*" },
              {
                Sid: "DenyNonAlertingTables",
                Effect: "Deny",
                Action: "dynamodb:*",
                Resource: resources,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    this.registerOutputs({ policy: this.policy });
  }
}
