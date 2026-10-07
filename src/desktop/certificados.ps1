# Certificado digital A3 (token ou cartão) pelo Windows, para o app de desktop.
#   listar:   devolve em JSON os certificados pessoais com chave, ainda válidos
#   assinar:  assina (CMS destacado, SHA-256) o arquivo -Entrada com o certificado
#             -Digital (impressão digital) e grava a assinatura em -Saida.
#             O driver do token mostra a janela pedindo o PIN.
param(
  [Parameter(Mandatory = $true)][ValidateSet('listar', 'assinar')][string]$Acao,
  [string]$Entrada,
  [string]$Saida,
  [string]$Digital
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Security

if ($Acao -eq 'listar') {
  $lista = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } | ForEach-Object {
    [pscustomobject]@{
      thumb   = $_.Thumbprint
      name    = $_.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
      issuer  = $_.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $true)
      icp     = [bool]($_.Issuer -match 'ICP-Brasil')
      validTo = $_.NotAfter.ToString('o')
    }
  })
  ConvertTo-Json -InputObject $lista -Compress
  exit 0
}

$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $Digital } | Select-Object -First 1
if (-not $cert) { throw 'Certificado não encontrado. Confira se o token ou cartão está conectado.' }
$dados = [IO.File]::ReadAllBytes($Entrada)
$conteudo = New-Object System.Security.Cryptography.Pkcs.ContentInfo (, $dados)
$cms = New-Object System.Security.Cryptography.Pkcs.SignedCms ($conteudo, $true)
$signer = New-Object System.Security.Cryptography.Pkcs.CmsSigner ($cert)
$signer.DigestAlgorithm = New-Object System.Security.Cryptography.Oid '2.16.840.1.101.3.4.2.1'
$signer.IncludeOption = [System.Security.Cryptography.X509Certificates.X509IncludeOption]::WholeChain
[void]$signer.SignedAttributes.Add((New-Object System.Security.Cryptography.Pkcs.Pkcs9SigningTime))
$cms.ComputeSignature($signer, $false)
[IO.File]::WriteAllBytes($Saida, $cms.Encode())
