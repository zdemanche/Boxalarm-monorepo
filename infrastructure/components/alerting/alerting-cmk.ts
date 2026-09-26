import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { IamPolicyStatement } from "../observability/observability-policy";

/**
 * The alerting table is encrypted with a customer-managed key (data/alerting-table.ts)
 * whose key policy delegates to IAM (data/cmk-policy.ts). DynamoDB uses that key on the
 * *calling* principal's behalf, so every role that reads or writes the table — or reads
 * its stream — needs these KMS actions on the CMK itself; the table's own
 * dynamodb.amazonaws.com service statement is not enough. Without them the first
 * GetItem/PutItem/GetRecords fails with KMSAccessDeniedException.
 *
 * Scoped by kms:ViaService so the role can use the key only through DynamoDB in the
 * key's own region — never for direct Encrypt/Decrypt calls.
 */
export function alertingCmkStatement(cmkArn: string): IamPolicyStatement {
  const region = cmkArn.split(":")[3];
  if (!cmkArn.startsWith("arn:") || !region) {
    throw new Error(
      `alertingCmkStatement: cmkArn must be a KMS key ARN (received ${JSON.stringify(cmkArn)})`,
    );
  }
  return {
    Sid: "AlertingTableCmkViaDynamoDb",
    Effect: "Allow",
    Action: [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
      "kms:CreateGrant",
    ],
    Resource: cmkArn,
    Condition: { StringEquals: { "kms:ViaService": [`dynamodb.${region}.amazonaws.com`] } },
  };
}

/**
 * Attaches alertingCmkStatement to each role as its own inline policy. Components call
 * this once over every role they create that touches the alerting table, so a new
 * alerting Lambda in the same component is one array entry, not a bespoke statement.
 */
export function grantAlertingCmk(
  name: string,
  roles: Record<string, aws.iam.Role>,
  cmkArn: pulumi.Input<string>,
  opts: pulumi.CustomResourceOptions,
): aws.iam.RolePolicy[] {
  return Object.entries(roles).map(
    ([key, role]) =>
      new aws.iam.RolePolicy(
        `${name}-${key}-alerting-cmk`,
        {
          role: role.id,
          policy: pulumi
            .output(cmkArn)
            .apply((arn) =>
              JSON.stringify({ Version: "2012-10-17", Statement: [alertingCmkStatement(arn)] }),
            ),
        },
        opts,
      ),
  );
}
