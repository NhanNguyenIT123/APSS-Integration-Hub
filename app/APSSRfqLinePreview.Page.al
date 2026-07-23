page 70303 "APSS RFQ Line Preview"
{
    PageType = List;
    SourceTable = "APSS RFQ Line Buffer";
    Caption = 'APSS RFQ Line Preview';
    UsageCategory = None;

    layout
    {
        area(Content)
        {
            repeater(Group)
            {
                field("Line No."; Rec."Line No.")
                {
                    ApplicationArea = All;
                    Editable = false;
                }
                field("Material Code"; Rec."Material Code")
                {
                    ApplicationArea = All;
                    Editable = false;
                    DrillDown = true;

                    trigger OnDrillDown()
                    begin
                        ShowFullValue('Material Code', Rec."Material Code");
                    end;
                }
                field("Material Description"; Rec."Material Description")
                {
                    ApplicationArea = All;
                    Editable = false;
                    DrillDown = true;

                    trigger OnDrillDown()
                    begin
                        ShowFullValue('Material Description', Rec."Material Description");
                    end;
                }
                field("Part Number"; Rec."Part Number")
                {
                    ApplicationArea = All;
                    Editable = false;
                    DrillDown = true;

                    trigger OnDrillDown()
                    begin
                        ShowFullValue('Part Number', Rec."Part Number");
                    end;
                }
                field(Manufacturer; Rec.Manufacturer)
                {
                    ApplicationArea = All;
                    Editable = false;
                    DrillDown = true;

                    trigger OnDrillDown()
                    begin
                        ShowFullValue('Manufacturer', Rec.Manufacturer);
                    end;
                }
                field(UOM; Rec.UOM)
                {
                    ApplicationArea = All;
                    Editable = false;
                }
                field(Quantity; Rec.Quantity)
                {
                    ApplicationArea = All;
                    Editable = false;
                }
                field("Match Status"; Rec."Match Status")
                {
                    ApplicationArea = All;
                    StyleExpr = StyleTxt;
                }
                field("Matched Item No."; Rec."Matched Item No.")
                {
                    ApplicationArea = All;
                    
                    trigger OnValidate()
                    var
                        Item: Record Item;
                        SyncCU: Codeunit "APSS Middleware Sync";
                        HasPartMatch: Boolean;
                        NewScore: Decimal;
                        CandidateReason: Text[250];
                    begin
                        if Rec."Matched Item No." <> '' then begin
                            Rec."Match Status" := Rec."Match Status"::"Auto-Link";
                            if Item.Get(Rec."Matched Item No.") then begin
                                HasPartMatch := SyncCU.CheckItemHasExactPartMatch(Item, Rec."Part Number");
                                NewScore := SyncCU.EvaluateCandidateScore(Rec."Material Description", Rec."Part Number", Rec.Manufacturer, Item, HasPartMatch, CandidateReason);
                                Rec."Match Score" := Round(NewScore * 100, 0.01);
                                Rec."Match Reason" := CopyStr('Manually selected. ' + CandidateReason, 1, MaxStrLen(Rec."Match Reason"));
                            end else begin
                                Rec."Match Score" := 100.0;
                                Rec."Match Reason" := 'Manually selected by user';
                            end;
                        end else begin
                            Rec."Match Status" := Rec."Match Status"::"Create Blank";
                            Rec."Match Score" := 0;
                            Rec."Match Reason" := 'Manual create blank';
                        end;
                        Rec.CalcFields("BC Item Description");
                    end;
                }
                field("BC Item Description"; Rec."BC Item Description")
                {
                    ApplicationArea = All;
                    Editable = false;
                    DrillDown = true;

                    trigger OnDrillDown()
                    begin
                        Rec.CalcFields("BC Item Description");
                        ShowFullValue('BC Item Description', Rec."BC Item Description");
                    end;
                }

                field("Match Score %"; Rec."Match Score")
                {
                    ApplicationArea = All;
                    Editable = false;
                }
                field("Match Reason"; Rec."Match Reason")
                {
                    ApplicationArea = All;
                    Editable = false;
                    DrillDown = true;

                    trigger OnDrillDown()
                    begin
                        if Rec."Match Reason" <> '' then
                            Message(Rec."Match Reason");
                    end;
                }
            }
        }
    }

    actions
    {
        area(Processing)
        {
            action(CreateQuote)
            {
                ApplicationArea = All;
                Caption = 'Confirm & Create Quote';
                ToolTip = 'Processes the current RFQ lines buffer: creates Item Cards for Create Blank items and generates a Sales Quote linked to the Opportunity.';
                Image = CreateDocument;
                Promoted = true;
                PromotedCategory = Process;
                PromotedIsBig = true;

                trigger OnAction()
                var
                    SyncCU: Codeunit "APSS Middleware Sync";
                begin
                    SyncCU.CreateQuoteFromRfqBuffer(Rec."RFQ No.");
                    CurrPage.Close();
                end;
            }
            action(RefreshLines)
            {
                ApplicationArea = All;
                Caption = 'Refresh Lines';
                ToolTip = 'Deletes local cached lines and pulls the latest data from the middleware.';
                Image = Refresh;
                Promoted = true;
                PromotedCategory = Process;
                PromotedIsBig = true;

                trigger OnAction()
                var
                    SyncCU: Codeunit "APSS Middleware Sync";
                begin
                    SyncCU.FetchAndPreviewRfqLines(Rec."RFQ No.");
                    CurrPage.Update(false);
                end;
            }
        }
    }

    trigger OnAfterGetRecord()
    begin
        Rec.CalcFields("BC Item Description");
        
        case Rec."Match Status" of
            Rec."Match Status"::"Auto-Link":
                StyleTxt := 'Favorable';
            Rec."Match Status"::Review:
                StyleTxt := 'Ambiguous';
            else
                StyleTxt := 'Attention';
        end;
    end;

    local procedure ShowFullValue(FieldCaption: Text; FieldValue: Text)
    begin
        if FieldValue = '' then
            Message('%1 is blank.', FieldCaption)
        else
            Message('%1:\\%2', FieldCaption, FieldValue);
    end;

    var
        StyleTxt: Text;
}
